import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { IMAGE_TYPES, LIBRARY_MAX_BYTES } from '@shared/config/mediaLimits'
import type { AssetQuery, ImageAsset, ImportResult } from '@shared/types/images'
import type { AssetRepository, AssetRow } from '../database/sqlite/assetRepository'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import type { ScopedLogger } from '../logging/logger'
import { inspectImage } from './imageInfo'

interface Deps {
  repo: AssetRepository
  /** Application-managed folder, e.g. <userData>/assets. */
  dir: string
  log: ScopedLogger
  onChange: () => void
}

export const ASSET_URL_PREFIX = 'relay-asset://asset/'
const FILE_NAME = /^[0-9a-f-]{36}\.(jpg|png|gif|webp)$/
const UNKEPT_DAYS = 7

const cleanName = (name: string) => basename(name).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'image'

/**
 * The local image library. Files live in an app-managed folder under
 * generated names (<id>.<ext>); SQLite holds metadata and the relative path.
 * Writes go to a temporary file that is synced and then renamed, so an
 * interrupted write never leaves a half-written image behind.
 */
export class AssetService {
  constructor(private readonly deps: Deps) {}

  get folder(): string {
    return this.deps.dir
  }

  list(query: AssetQuery = {}): ImageAsset[] {
    return this.deps.repo.list(query).map((row) => this.view(row))
  }

  get(id: string): ImageAsset {
    const row = this.deps.repo.get(id)
    if (!row) throw new NotFoundError('That image is no longer in the library.')
    return this.view(row)
  }

  byIds(ids: string[]): ImageAsset[] {
    return this.deps.repo.byIds(ids).map((row) => this.view(row))
  }

  stats() {
    return { ...this.deps.repo.stats(), folder: this.deps.dir }
  }

  /** Imports files chosen in the main process's file dialog. Each file is validated by content. */
  async importFiles(paths: string[]): Promise<ImportResult> {
    const result: ImportResult = { imported: [], existing: [], rejected: [], cancelled: false }
    for (const path of paths.slice(0, 50)) {
      const name = cleanName(path)
      try {
        const info = await lstat(path)
        if (!info.isFile()) throw new ValidationError('Not a regular file.')
        if (info.size > LIBRARY_MAX_BYTES) throw new ValidationError(`Larger than ${LIBRARY_MAX_BYTES / 1024 / 1024} MB — too big for any X post.`)
        const bytes = await readFile(path)
        const saved = await this.store(bytes, { origin: 'upload', originalName: name, prompt: null, generationId: null, kept: true })
        if (saved.created) result.imported.push(saved.asset)
        else result.existing.push(saved.asset)
      } catch (error) {
        result.rejected.push({ name, reason: error instanceof ValidationError ? error.message : 'The file could not be read.' })
      }
    }
    if (result.imported.length || result.existing.length) {
      this.deps.log.info(`Imported ${result.imported.length} image(s)`, { existing: result.existing.length, rejected: result.rejected.length })
      this.deps.onChange()
    }
    if (result.rejected.length) this.deps.log.warn(`Rejected ${result.rejected.length} file(s) on import`)
    return result
  }

  /** Stores an image returned by a provider. Not kept in the library until saved or attached. */
  async saveGenerated(bytes: Buffer, meta: { prompt: string; generationId: string; extensionHint: string }): Promise<ImageAsset> {
    const saved = await this.store(bytes, {
      origin: 'generated',
      originalName: `generated-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${meta.extensionHint}`,
      prompt: meta.prompt.slice(0, 4000),
      generationId: meta.generationId,
      kept: false
    })
    return saved.asset
  }

  keep(id: string): ImageAsset {
    const row = this.deps.repo.get(id)
    if (!row) throw new NotFoundError('That image is no longer in the library.')
    this.deps.repo.setKept(id, true)
    this.deps.onChange()
    return this.get(id)
  }

  /** Deletes an image. Refused while any draft attaches it. */
  async remove(id: string): Promise<void> {
    const row = this.deps.repo.get(id)
    if (!row) return
    if (row.usedBy > 0) {
      throw new ConflictError(`This image is attached to ${row.usedBy} draft${row.usedBy === 1 ? '' : 's'}. Remove it from ${row.usedBy === 1 ? 'that draft' : 'those drafts'} first.`)
    }
    this.deps.repo.remove(id)
    await this.unlink(row.filePath)
    this.deps.log.info(`Deleted image ${id.slice(0, 8)}`, { origin: row.origin })
    this.deps.onChange()
  }

  /** Absolute path for the asset protocol — only inside the asset folder, only if it exists. */
  fileFor(id: string): { path: string; mimeType: string } | null {
    const row = this.deps.repo.get(id)
    if (!row) return null
    const path = this.absolute(row.filePath)
    return path && existsSync(path) ? { path, mimeType: row.mimeType } : null
  }

  /**
   * Housekeeping at startup: forget generated images nobody kept for a week,
   * and remove stray temp files and files no record points to.
   */
  async sweep(): Promise<{ unkept: number; orphans: number }> {
    let unkept = 0
    let orphans = 0
    const cutoff = new Date(Date.now() - UNKEPT_DAYS * 86_400_000).toISOString()
    for (const row of this.deps.repo.staleUnkept(cutoff)) {
      this.deps.repo.remove(row.id)
      await this.unlink(row.filePath)
      unkept++
    }
    const known = this.deps.repo.knownFiles()
    const hourAgo = Date.now() - 3_600_000
    for (const sub of await readdir(this.deps.dir).catch(() => [] as string[])) {
      const subDir = join(this.deps.dir, sub)
      if (!/^\d{4}-\d{2}$/.test(sub)) continue
      for (const file of await readdir(subDir).catch(() => [] as string[])) {
        const full = join(subDir, file)
        const rel = `${sub}/${file}`
        const old = (await stat(full).catch(() => null))?.mtimeMs ?? Date.now()
        if (old > hourAgo) continue
        if (file.endsWith('.tmp') || (FILE_NAME.test(file) && !known.has(rel))) {
          await rm(full, { force: true })
          orphans++
        }
      }
    }
    if (unkept || orphans) this.deps.log.info('Cleaned up image files', { unkept, orphans })
    return { unkept, orphans }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async store(
    bytes: Buffer,
    meta: { origin: AssetRow['origin']; originalName: string; prompt: string | null; generationId: string | null; kept: boolean }
  ): Promise<{ asset: ImageAsset; created: boolean }> {
    if (bytes.length > LIBRARY_MAX_BYTES) throw new ValidationError('The image is larger than 15 MB.')
    const info = inspectImage(bytes)
    if (typeof info === 'string') throw new ValidationError(info)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const existing = this.deps.repo.bySha(sha256)
    if (existing && existsSync(this.absolute(existing.filePath) ?? '')) {
      if (meta.kept && !existing.kept) this.deps.repo.setKept(existing.id, true)
      return { asset: this.get(existing.id), created: false }
    }
    if (existing) {
      // Same content as a record whose file went missing: put the file back, so drafts using it work again.
      const target = this.absolute(existing.filePath)
      if (!target) throw new ValidationError('The stored image path is invalid.')
      await mkdir(resolve(target, '..'), { recursive: true })
      await this.writeAtomic(target, bytes)
      if (meta.kept && !existing.kept) this.deps.repo.setKept(existing.id, true)
      this.deps.log.info(`Restored missing file for image ${existing.id.slice(0, 8)}`)
      return { asset: this.get(existing.id), created: true }
    }

    const id = randomUUID()
    const month = new Date().toISOString().slice(0, 7)
    const rel = `${month}/${id}.${IMAGE_TYPES[info.mimeType].extension}`
    const target = this.absolute(rel)!
    await mkdir(join(this.deps.dir, month), { recursive: true })
    try {
      await this.writeAtomic(target, bytes)
      this.deps.repo.insert({
        id,
        origin: meta.origin,
        originalName: meta.originalName,
        filePath: rel,
        mimeType: info.mimeType,
        width: info.width,
        height: info.height,
        sizeBytes: bytes.length,
        sha256,
        animated: info.animated,
        prompt: meta.prompt,
        generationId: meta.generationId,
        kept: meta.kept,
        createdAt: new Date().toISOString()
      })
    } catch (error) {
      await rm(target, { force: true })
      throw error
    }
    return { asset: this.get(id), created: true }
  }

  /** Write to a synced temp file, then rename over the target (atomic on the same volume). */
  private async writeAtomic(target: string, bytes: Buffer): Promise<void> {
    const temp = `${target}.${randomUUID().slice(0, 8)}.tmp`
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }

  private absolute(rel: string): string | null {
    const full = resolve(this.deps.dir, rel)
    const inside = relative(this.deps.dir, full)
    return inside && !inside.startsWith('..') && !inside.includes(`..${sep}`) ? full : null
  }

  private async unlink(rel: string): Promise<void> {
    const full = this.absolute(rel)
    if (!full) return
    await rm(full, { force: true }).catch((error: Error) => this.deps.log.warn(`Could not delete an image file: ${error.message}`))
  }

  private view(row: AssetRow): ImageAsset {
    const path = this.absolute(row.filePath)
    return {
      id: row.id,
      origin: row.origin,
      originalName: row.originalName,
      mimeType: row.mimeType,
      width: row.width,
      height: row.height,
      sizeBytes: row.sizeBytes,
      animated: row.animated,
      prompt: row.prompt,
      generationId: row.generationId,
      kept: row.kept,
      available: Boolean(path && existsSync(path)),
      usedBy: row.usedBy,
      url: `${ASSET_URL_PREFIX}${row.id}`,
      createdAt: row.createdAt
    }
  }
}
