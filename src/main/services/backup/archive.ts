import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { Transform, Writable, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

/**
 * A minimal, dependency-free backup container: a gzip-compressed POSIX
 * (ustar) tar holding regular files only. Written and read as streams, so
 * large image folders never have to fit in memory. Every file's SHA-256 is
 * computed while writing and checked again while reading.
 */

const BLOCK = 512
const MAX_NAME = 100
/** Allowed entry names: the manifest, the database, and files under assets/. */
const NAME = /^(manifest\.json|data\/relay\.db|assets\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)$/
const MAX_ENTRY_BYTES = 8 * 1024 ** 3

export interface ArchiveSource {
  name: string
  /** File on disk, or in-memory content. */
  path?: string
  data?: Buffer
}

export interface ArchiveFile {
  name: string
  size: number
  sha256: string
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveError'
  }
}

export function validEntryName(name: string): boolean {
  return name.length <= MAX_NAME && NAME.test(name) && !name.split('/').includes('..')
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0'
}

function header(name: string, size: number, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0)
  block.write(name, 0, MAX_NAME, 'utf8')
  block.write(octal(0o644, 8), 100, 'ascii')
  block.write(octal(0, 8), 108, 'ascii')
  block.write(octal(0, 8), 116, 'ascii')
  block.write(octal(size, 12), 124, 'ascii')
  block.write(octal(Math.floor(mtime / 1000), 12), 136, 'ascii')
  block.write('        ', 148, 'ascii') // checksum placeholder (8 spaces)
  block.write('0', 156, 'ascii')
  block.write('ustar\0', 257, 'ascii')
  block.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return block
}

/**
 * Writes `sources` (in order) to a .tar.gz at `destination`. `manifest`, when
 * given, is called with the files written so far and its result is appended
 * as the last entry (manifest.json), so it can carry their checksums.
 */
export async function writeArchive(destination: string, sources: ArchiveSource[], manifest?: (files: ArchiveFile[]) => Buffer): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = []
  const gzip = createGzip({ level: 6 })
  const output = createWriteStream(destination, { flags: 'wx' })
  const done = pipeline(gzip, output)
  const write = (chunk: Buffer) => new Promise<void>((resolve, reject) => (gzip.write(chunk, (error) => (error ? reject(error) : resolve()))))

  const add = async (source: ArchiveSource) => {
    if (!validEntryName(source.name)) throw new ArchiveError(`Unsupported file name in backup: ${source.name}`)
    const hash = createHash('sha256')
    let size: number
    if (source.data) {
      size = source.data.length
      await write(header(source.name, size, Date.now()))
      hash.update(source.data)
      await write(source.data)
    } else if (source.path) {
      const handle = await open(source.path, 'r')
      const info = await handle.stat()
      await handle.close()
      size = info.size
      await write(header(source.name, size, info.mtimeMs))
      let written = 0
      for await (const chunk of createReadStream(source.path) as AsyncIterable<Buffer>) {
        written += chunk.length
        if (written > size) throw new ArchiveError(`${source.name} changed while it was being backed up.`)
        hash.update(chunk)
        await write(chunk)
      }
      if (written !== size) throw new ArchiveError(`${source.name} changed while it was being backed up.`)
    } else {
      throw new ArchiveError('Nothing to write.')
    }
    const padding = (BLOCK - (size % BLOCK)) % BLOCK
    if (padding) await write(Buffer.alloc(padding, 0))
    files.push({ name: source.name, size, sha256: hash.digest('hex') })
  }

  try {
    for (const source of sources) await add(source)
    if (manifest) await add({ name: 'manifest.json', data: manifest([...files]) })
    await write(Buffer.alloc(BLOCK * 2, 0))
    gzip.end()
    await done
    return files
  } catch (error) {
    gzip.destroy()
    output.destroy()
    await done.catch(() => undefined)
    throw error
  }
}

export interface EntryHandler {
  /** Called for each file; return a Writable to receive its bytes, or null to skip (still hashed). */
  (entry: { name: string; size: number }): Writable | null | Promise<Writable | null>
}

/**
 * Reads a .tar.gz written by writeArchive, hashing every file. Rejects
 * anything unexpected (other entry types, unsafe names, truncation).
 */
export async function readArchive(path: string, onEntry: EntryHandler): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = []
  let buffer: Buffer = Buffer.alloc(0)
  type Current = { name: string; size: number; remaining: number; padding: number; hash: ReturnType<typeof createHash>; sink: Writable | null }
  let current = null as Current | null
  let ended = false

  const writeTo = (sink: Writable, chunk: Buffer) => new Promise<void>((resolve, reject) => sink.write(chunk, (error) => (error ? reject(error) : resolve())))
  const closeSink = (sink: Writable) => new Promise<void>((resolve, reject) => sink.end((error?: Error | null) => (error ? reject(error) : resolve())))

  // The write callback below is async; failures must wait for it to settle
  // (so no file or folder is created after the caller cleaned up).
  let inflight: Promise<void> = Promise.resolve()
  const parser = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      inflight = (async () => {
      try {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
        for (;;) {
          if (ended) {
            buffer = Buffer.alloc(0)
            break
          }
          if (current) {
            if (current.remaining > 0) {
              if (!buffer.length) break
              const take = buffer.subarray(0, Math.min(current.remaining, buffer.length))
              buffer = buffer.subarray(take.length)
              current.remaining -= take.length
              current.hash.update(take)
              if (current.sink) await writeTo(current.sink, take)
              continue
            }
            if (buffer.length < current.padding) break
            buffer = buffer.subarray(current.padding)
            if (current.sink) await closeSink(current.sink)
            files.push({ name: current.name, size: current.size, sha256: current.hash.digest('hex') })
            current = null
            continue
          }
          if (buffer.length < BLOCK) break
          const block = buffer.subarray(0, BLOCK)
          buffer = buffer.subarray(BLOCK)
          if (block.every((b) => b === 0)) {
            ended = true
            continue
          }
          const name = block.subarray(0, MAX_NAME).toString('utf8').replace(/\0.*$/s, '')
          const type = String.fromCharCode(block[156]!)
          const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8)
          let sum = 0
          for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!
          const stored = parseInt(block.subarray(148, 156).toString('ascii').replace(/\0.*$/s, '').trim(), 8)
          if (sum !== stored) throw new ArchiveError('The backup file is damaged (bad header).')
          if (type !== '0' && type !== '\0') throw new ArchiveError('The backup contains an unexpected entry.')
          if (!validEntryName(name)) throw new ArchiveError('The backup contains an unexpected file name.')
          if (!Number.isFinite(size) || size < 0 || size > MAX_ENTRY_BYTES) throw new ArchiveError('The backup contains a file of an unexpected size.')
          if (files.some((f) => f.name === name)) throw new ArchiveError('The backup contains a file twice.')
          const sink = await onEntry({ name, size })
          // Errors reach us through the write callbacks; keep stray 'error' events from crashing the process.
          sink?.on('error', () => undefined)
          current = { name, size, remaining: size, padding: (BLOCK - (size % BLOCK)) % BLOCK, hash: createHash('sha256'), sink }
          if (size === 0) continue
        }
        callback()
      } catch (error) {
        callback(error as Error)
      }
      })()
    }
  })

  try {
    await pipeline(createReadStream(path) as Readable, createGunzip(), parser)
  } catch (error) {
    await inflight.catch(() => undefined)
    const sink = current?.sink
    if (sink && !sink.closed) {
      // Wait for the file handle to close before the caller removes the folder.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000)
        sink.once('close', () => (clearTimeout(timer), resolve()))
        sink.destroy()
      })
    }
    if (error instanceof ArchiveError) throw error
    throw new ArchiveError('The backup file is damaged or incomplete.')
  }
  if (current || !ended) throw new ArchiveError('The backup file is incomplete.')
  return files
}

/** A Writable that discards data (used to verify without extracting). */
export function discard(): Writable {
  return new Writable({ write: (_chunk, _encoding, callback) => callback() })
}

/** Collects a small entry (e.g. the manifest) into memory, up to `max` bytes. */
export function collect(max: number): { sink: Writable; result: () => Buffer } {
  const parts: Buffer[] = []
  let size = 0
  const sink = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (size > max) return callback(new ArchiveError('The backup manifest is too large.'))
      parts.push(chunk)
      callback()
    }
  })
  sink.resume()
  return { sink, result: () => Buffer.concat(parts) }
}
