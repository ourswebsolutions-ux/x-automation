import { app, BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from 'electron'
import { dirname } from 'node:path'
import { z } from 'zod'
import { TEST_PROMPT_MAX_CHARS } from '@shared/config/aiAdapters'
import { ASSIST_TOOLS, TONES } from '@shared/types/generator'
import { IMAGE_STYLES } from '@shared/types/images'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { APP_NAME, APP_PHASE } from '@shared/config/app'
import type { AutomationConfig } from '@shared/types/automation'
import { automationConfigSchema } from '../services/automation/configSchema'
import { MODEL_PATTERN } from '@shared/config/providers'
import { IpcChannel } from '@shared/ipc/channels'
import type { AppInfo, SecurityPosture, WindowState } from '@shared/types/system'
import type { AppServices } from '../services/container'
import { AiServiceError } from '../services/ai/errors'
import { ValidationError } from '../services/errors'
import { preferencesPatchSchema } from '../services/preferences/schema'
import { isSafeExternalUrl } from '../security/trust'
import { SECURE_WEB_PREFERENCES } from '../window'
import { createIpcRouter, noPayload } from './router'

export function windowState(window: BrowserWindow): WindowState {
  return { isMaximized: window.isMaximized(), isFocused: window.isFocused() }
}

const id = z.uuid()
const providerKind = z.enum(['ixbrowser', 'openai-compatible', 'image'])
const providerInput = z
  .object({
    kind: providerKind,
    name: z.string().max(200),
    endpoint: z.string().max(400),
    model: z.string().max(200).nullable(),
    adapter: z.enum(['openai', 'openai-chat', 'openai-images']).nullable().optional(),
    enabled: z.boolean(),
    settings: z
      .object({
        timeoutMs: z.number().int().min(1000).max(120_000),
        retries: z.number().int().min(0).max(5),
        generation: z
          .object({
            temperature: z.number().min(0).max(2).nullable(),
            maxOutputTokens: z.number().int().min(1).max(128_000).nullable()
          })
          .strict()
          .optional(),
        image: z
          .object({
            size: z.string().regex(/^(auto|\d{2,4}x\d{2,4})$/),
            quality: z.string().regex(/^[a-z]{2,10}$/).nullable(),
            format: z.enum(['png', 'jpeg', 'webp']).nullable()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional()
  })
  .strict()
const logLevel = z.enum(['debug', 'info', 'success', 'warning', 'error'])

const windowOf = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)

export function registerIpcHandlers(services: AppServices, getWindow: () => BrowserWindow | null): void {
  const log = services.logger.scope('ipc')
  const handle = createIpcRouter(log)
  const { preferences, providers, database, backup, logger } = services

  const withWindow = (action: (window: BrowserWindow) => void) => () => {
    const window = getWindow()
    if (window && !window.isDestroyed()) action(window)
  }

  // Window chrome
  handle(IpcChannel.WindowMinimize, noPayload, withWindow((w) => w.minimize()))
  handle(IpcChannel.WindowToggleMaximize, noPayload, withWindow((w) => (w.isMaximized() ? w.unmaximize() : w.maximize())))
  handle(IpcChannel.WindowClose, noPayload, withWindow((w) => w.close()))
  handle(IpcChannel.WindowGetState, noPayload, () => {
    const window = getWindow()
    return window ? windowState(window) : { isMaximized: false, isFocused: true }
  })

  // App information
  handle(
    IpcChannel.AppGetInfo,
    noPayload,
    (): AppInfo => ({
      name: APP_NAME,
      version: app.getVersion(),
      phase: APP_PHASE,
      platform: process.platform,
      arch: process.arch,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      isPackaged: app.isPackaged,
      loginItemSupported: app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin')
    })
  )
  handle(
    IpcChannel.AppGetSecurity,
    noPayload,
    (): SecurityPosture => ({
      contextIsolation: SECURE_WEB_PREFERENCES.contextIsolation,
      sandbox: SECURE_WEB_PREFERENCES.sandbox,
      nodeIntegration: SECURE_WEB_PREFERENCES.nodeIntegration,
      webSecurity: SECURE_WEB_PREFERENCES.webSecurity,
      credentialEncryptionAvailable: services.vault.status().secure
    })
  )

  // Preferences
  handle(IpcChannel.PreferencesGet, noPayload, () => preferences.get())
  handle(IpcChannel.PreferencesUpdate, preferencesPatchSchema, (patch) => {
    for (const key of ['textProviderId', 'imageProviderId'] as const) {
      const value = patch.defaults?.[key]
      if (value) {
        const config = providers.get(value)
        const expected = key === 'textProviderId' ? 'openai-compatible' : 'image'
        if (config.kind !== expected) throw new ValidationError('That provider has the wrong type for this default.')
      }
    }
    return preferences.update(patch)
  })
  handle(IpcChannel.PreferencesReset, noPayload, () => preferences.reset())

  // Integrations & workspace
  handle(IpcChannel.IntegrationsList, noPayload, () => services.integrations.list())
  handle(IpcChannel.WorkspaceSummary, noPayload, () => services.workspace.getSummary())

  // Drafts
  handle(IpcChannel.DraftsList, noPayload, () => services.drafts.list())
  const hashtagList = z.array(z.string().max(101)).max(30)
  handle(
    IpcChannel.DraftsSave,
    z
      .object({
        id: id.optional(),
        body: z.string().max(25_000, 'Drafts can be up to 25,000 characters.'),
        hashtags: hashtagList.optional(),
        status: z.enum(['draft', 'ready']).optional(),
        accountId: id.nullable(),
        aiAssisted: z.boolean().optional(),
        sourceGenerationId: id.nullable().optional(),
        attachments: z
          .array(z.object({ assetId: id, altText: z.string().max(1000, 'Image descriptions can be up to 1,000 characters.') }).strict())
          .max(4, 'A post can have up to 4 images.')
          .optional()
      })
      .strict(),
    (input) => services.drafts.save(input)
  )
  handle(IpcChannel.DraftsDuplicate, id, (draftId) => services.drafts.duplicate(draftId))
  handle(IpcChannel.DraftsRemove, id, (draftId) => services.drafts.remove(draftId))

  // Generator & AI editing tools — validated here and again in GeneratorService.
  const tone = z.enum(TONES)
  const lengthProfile = z.enum(['standard', 'premium'])
  const runOptions = z
    .object({ requestId: id, providerId: id.optional(), model: z.string().trim().regex(MODEL_PATTERN, 'That model name is not valid.').optional() })
    .strict()
  const brief = z
    .object({
      topic: z.string().max(200, 'Keep the topic under 200 characters.'),
      keyPoints: z.string().max(2000, 'Keep the key points under 2,000 characters.'),
      audience: z.string().max(200, 'Keep the audience under 200 characters.'),
      tone,
      language: z.string().max(40),
      length: z.enum(['short', 'medium', 'long']),
      variations: z.number().int().min(1).max(5),
      hashtags: hashtagList.max(10),
      suggestHashtags: z.boolean(),
      callToAction: z.string().max(200, 'Keep the call to action under 200 characters.'),
      instructions: z.string().max(1000, 'Keep additional instructions under 1,000 characters.'),
      lengthProfile
    })
    .strict()
  const assist = z
    .object({
      tool: z.enum(ASSIST_TOOLS),
      text: z.string().max(25_000),
      hashtags: hashtagList,
      draftId: id.nullable(),
      tone: tone.optional(),
      language: z.string().max(40).optional(),
      variations: z.number().int().min(1).max(5).optional(),
      lengthProfile
    })
    .strict()
  handle(IpcChannel.GeneratorGenerate, z.object({ brief, options: runOptions }).strict(), ({ brief: b, options }) => services.generator.generate(b, options))
  handle(IpcChannel.GeneratorAssist, z.object({ request: assist, options: runOptions }).strict(), ({ request, options }) => services.generator.assist(request, options))
  handle(
    IpcChannel.GeneratorHistory,
    z.object({ limit: z.number().int().min(1).max(200).optional(), draftId: id.optional(), operation: z.enum(['generate', 'assist']).optional() }).strict().optional(),
    (query) => services.generator.history(query ?? {})
  )
  handle(IpcChannel.GeneratorGet, id, (generationId) => services.generator.get(generationId))

  // Providers — keys are write-only: no handler ever returns a secret.
  handle(IpcChannel.ProvidersList, providerKind.optional(), (kind) => providers.list(kind))
  handle(IpcChannel.ProvidersCreate, providerInput, (input) => providers.create(input))
  handle(IpcChannel.ProvidersUpdate, z.object({ id, input: providerInput }).strict(), ({ id: providerId, input }) =>
    providers.update(providerId, input)
  )
  handle(IpcChannel.ProvidersRemove, id, (providerId) => providers.remove(providerId))
  handle(IpcChannel.ProvidersSetKey, z.object({ id, secret: z.string().min(1).max(4096) }).strict(), ({ id: providerId, secret }) =>
    providers.setKey(providerId, secret)
  )
  handle(IpcChannel.ProvidersRemoveKey, id, (providerId) => providers.removeKey(providerId))

  // Credentials
  handle(IpcChannel.CredentialsStatus, noPayload, () => ({ ...services.vault.status(), storedCount: services.vault.keys().length }))
  handle(IpcChannel.CredentialsClearAll, noPayload, () => providers.clearAllKeys())

  // Database
  handle(IpcChannel.DatabaseInfo, noPayload, () => database.info(backup.lastBackupAt()))
  handle(IpcChannel.DatabaseHealth, noPayload, () => {
    const report = database.health()
    log.info(`Health check ${report.ok ? 'passed' : 'found problems'}`, { durationMs: report.durationMs })
    return report
  })
  handle(IpcChannel.DatabaseCompact, noPayload, () => {
    database.compact()
    return database.info(backup.lastBackupAt())
  })
  handle(IpcChannel.DatabaseOpenFolder, noPayload, async () => {
    await shell.openPath(dirname(database.path))
  })

  // IX Browser
  const { ixBrowser } = services
  handle(IpcChannel.IxOverview, noPayload, () => ixBrowser.overview())
  handle(IpcChannel.IxTestConnection, id.optional(), (providerId) => ixBrowser.testConnection(providerId))
  handle(IpcChannel.IxSync, noPayload, () => ixBrowser.sync())
  handle(IpcChannel.IxCancelSync, noPayload, () => ixBrowser.cancelSync())
  handle(IpcChannel.IxProfiles, noPayload, () => ixBrowser.listProfiles())
  handle(IpcChannel.IxSyncHistory, noPayload, () => ixBrowser.syncHistory(10))
  handle(IpcChannel.IxRefreshStatus, noPayload, () => ixBrowser.refreshStatus())
  const externalId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  handle(IpcChannel.IxOpenProfile, externalId, (profileId) => ixBrowser.openProfile(profileId))
  handle(IpcChannel.IxCloseProfile, externalId, (profileId) => ixBrowser.closeProfile(profileId))

  // Image library — the renderer never supplies a file path.
  const { assets, images } = services
  handle(
    IpcChannel.AssetsList,
    z
      .object({
        search: z.string().max(200).optional(),
        origin: z.enum(['upload', 'generated']).optional(),
        sort: z.enum(['newest', 'oldest', 'largest', 'name']).optional(),
        includeUnkept: z.boolean().optional()
      })
      .strict()
      .optional(),
    (query) => assets.list(query ?? {})
  )
  handle(IpcChannel.AssetsImport, noPayload, async (_input, event) => {
    const window = windowOf(event)
    const options = {
      title: 'Add images',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [{ name: 'Images (JPEG, PNG, GIF, WEBP)', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }]
    }
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) return { imported: [], existing: [], rejected: [], cancelled: true }
    return assets.importFiles(picked.filePaths)
  })
  handle(IpcChannel.AssetsKeep, id, (assetId) => assets.keep(assetId))
  handle(IpcChannel.AssetsRemove, id, (assetId) => assets.remove(assetId))
  handle(IpcChannel.AssetsStats, noPayload, () => assets.stats())
  handle(IpcChannel.AssetsOpenFolder, noPayload, async () => {
    await mkdir(assets.folder, { recursive: true })
    await shell.openPath(assets.folder)
  })

  // Image generation
  handle(
    IpcChannel.ImagesGenerate,
    z
      .object({
        request: z
          .object({
            prompt: z.string().max(32_000, 'That prompt is too long.'),
            size: z.string().regex(/^(auto|\d{2,4}x\d{2,4})$/, 'Choose a size.'),
            quality: z.string().regex(/^[a-z]{2,10}$/).nullable(),
            format: z.enum(['png', 'jpeg', 'webp']).nullable(),
            transparent: z.boolean(),
            count: z.number().int().min(1).max(10),
            draftId: id.nullable()
          })
          .strict(),
        options: z
          .object({ requestId: id, providerId: id.optional(), model: z.string().trim().regex(MODEL_PATTERN, 'That model name is not valid.').optional() })
          .strict()
      })
      .strict(),
    ({ request, options }) => images.generate(request, options)
  )
  handle(IpcChannel.ImagesHistory, z.number().int().min(1).max(100).optional(), (limit) => images.history(limit ?? 30))
  handle(
    IpcChannel.ImagesSuggestPrompt,
    z
      .object({
        postText: z.string().max(25_000),
        style: z.enum(IMAGE_STYLES),
        instructions: z.string().max(500, 'Keep extra direction under 500 characters.'),
        requestId: id,
        providerId: id.optional(),
        model: z.string().trim().regex(MODEL_PATTERN).optional()
      })
      .strict(),
    (input) => images.suggestPrompt(input)
  )

  // Automation engine & compatibility
  const { engine, automation, proxies } = services
  handle(IpcChannel.EngineStatus, noPayload, () => engine.status())
  handle(IpcChannel.EngineStart, noPayload, async () => {
    await engine.ensureStarted()
    return engine.status()
  })
  handle(IpcChannel.EngineRestart, noPayload, () => engine.restart())
  handle(IpcChannel.EngineStop, noPayload, async () => {
    await engine.stop('stopped from settings')
    return engine.status()
  })
  handle(IpcChannel.EngineSelfCheck, noPayload, () => automation.engineSelfCheck())
  handle(IpcChannel.EngineLastSelfCheck, noPayload, () => automation.lastSelfCheck())
  handle(IpcChannel.EngineOpenDiagnostics, noPayload, async () => {
    await mkdir(engine.diagnosticsDir, { recursive: true })
    await shell.openPath(engine.diagnosticsDir)
  })
  handle(IpcChannel.AutomationCheckProfile, id, (profileId) => automation.checkProfile(profileId))
  handle(IpcChannel.AutomationLastResult, id, (profileId) => automation.lastResult(profileId))

  // Proxies — passwords are write-only
  const proxyInput = z
    .object({
      label: z.string().max(80, 'Labels can be up to 80 characters.'),
      scheme: z.enum(['http', 'https', 'socks5']),
      host: z.string().trim().min(1, 'Enter a host.').max(255),
      port: z.number().int().min(1, 'Port must be 1–65535.').max(65535, 'Port must be 1–65535.'),
      username: z.string().max(255).nullable(),
      password: z.string().max(255, 'Proxy passwords can be up to 255 characters.').nullable().optional(),
      enabled: z.boolean(),
      notes: z.string().max(1000)
    })
    .strict()
  const profileIds = z.array(id).min(1).max(500)
  handle(IpcChannel.ProxiesList, noPayload, () => proxies.list())
  handle(IpcChannel.ProxiesCreate, proxyInput, (input) => proxies.create(input))
  handle(IpcChannel.ProxiesUpdate, z.object({ id, input: proxyInput }).strict(), ({ id: proxyId, input }) => proxies.update(proxyId, input))
  handle(IpcChannel.ProxiesRemove, id, (proxyId) => proxies.remove(proxyId))
  handle(IpcChannel.ProxiesSetDefault, id.nullable(), (proxyId) => proxies.setDefault(proxyId))
  handle(IpcChannel.ProxiesTest, id, (proxyId) => proxies.test(proxyId))
  handle(IpcChannel.ProxiesImport, z.enum(['http', 'https', 'socks5']), async (defaultScheme, event) => {
    const window = windowOf(event)
    const options = {
      title: 'Import proxies',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Proxy lists (TXT, CSV)', extensions: ['txt', 'csv'] }]
    }
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return { added: 0, duplicates: 0, rejected: [], cancelled: true }
    const path = picked.filePaths[0]
    const info = await stat(path)
    if (!info.isFile() || info.size > 1024 * 1024) throw new ValidationError('Choose a TXT or CSV file under 1 MB.')
    const text = await readFile(path, 'utf8')
    return proxies.import(text, path.toLowerCase().endsWith('.csv') ? 'csv' : 'txt', defaultScheme)
  })
  handle(IpcChannel.ProxiesExport, z.enum(['txt', 'csv']), async (format, event) => {
    const window = windowOf(event)
    const options = {
      title: 'Export proxies (without passwords)',
      defaultPath: `${app.getPath('documents')}/axora-relay-proxies.${format}`,
      filters: [{ name: format === 'csv' ? 'CSV' : 'Text', extensions: [format] }]
    }
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { cancelled: true }
    const { text, count } = proxies.export(format)
    await writeFile(result.filePath, text, 'utf8')
    logger.write('info', 'proxies', `Exported ${count} proxies (${format}, passwords excluded)`)
    return { cancelled: false, fileName: result.filePath.split(/[\\/]/).pop() ?? result.filePath, count }
  })
  handle(IpcChannel.ProxiesAssignments, noPayload, () => proxies.assignments())
  handle(IpcChannel.ProxiesAssign, z.object({ profileIds, proxyId: id }).strict(), ({ profileIds: ids, proxyId }) => proxies.assign(ids, proxyId))
  handle(IpcChannel.ProxiesUnassign, profileIds, (ids) => proxies.unassign(ids))
  handle(IpcChannel.ProxiesApplyDefault, noPayload, () => proxies.applyDefault())

  // AI providers — specific operations only; keys stay in the main process.
  const { ai } = services
  const aiOperation = z.enum(['connection-test', 'list-models', 'generate-text', 'generate-image'])
  const usageQuery = z
    .object({
      providerId: id.optional(),
      operation: aiOperation.optional(),
      status: z.enum(['succeeded', 'failed', 'cancelled']).optional(),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
      limit: z.number().int().min(1).max(1000).optional()
    })
    .strict()
    .optional()
  handle(IpcChannel.AiOverview, noPayload, () => ai.overview())
  handle(IpcChannel.AiTestConnection, id, (providerId) => ai.testConnection(providerId))
  handle(IpcChannel.AiListModels, z.object({ providerId: id, refresh: z.boolean() }).strict(), ({ providerId, refresh }) =>
    ai.listModels(providerId, refresh)
  )
  handle(
    IpcChannel.AiTestPrompt,
    z
      .object({
        providerId: id,
        requestId: id,
        prompt: z.string().trim().min(1, 'Type a prompt to send.').max(TEST_PROMPT_MAX_CHARS, `Test prompts can be up to ${TEST_PROMPT_MAX_CHARS} characters.`),
        model: z.string().trim().regex(MODEL_PATTERN, 'That model name is not valid.').optional()
      })
      .strict(),
    async (input) => {
      try {
        return { ok: true as const, result: await ai.testPrompt(input) }
      } catch (error) {
        if (error instanceof AiServiceError) return { ok: false as const, error: error.toJSON() }
        throw error
      }
    }
  )
  handle(IpcChannel.AiCancel, id, (requestId) => ai.cancel(requestId))
  handle(IpcChannel.AiUsageList, usageQuery, (query) => ai.usage(query ?? {}))
  handle(IpcChannel.AiUsageSummary, usageQuery, (query) => ai.usageSummary(query ?? {}))

  // Accounts — local records only; validated here, rules enforced in AccountService.
  const { accounts } = services
  const ids = z.array(id).min(1).max(500)
  const accountInput = z
    .object({
      label: z.string().trim().min(1, 'Give the account a label.').max(80, 'Labels can be up to 80 characters.'),
      handle: z
        .string()
        .trim()
        .max(16)
        .regex(/^@?[A-Za-z0-9_]{0,15}$/, 'An X username has 1–15 letters, numbers or underscores.')
        .nullable(),
      confirmIdentity: z.boolean(),
      notes: z.string().max(4000, 'Notes can be up to 4,000 characters.'),
      enabled: z.boolean()
    })
    .strict()
  handle(IpcChannel.AccountsList, noPayload, () => accounts.list())
  handle(IpcChannel.AccountsDetails, id, (accountId) => accounts.details(accountId))
  handle(IpcChannel.AccountsCreate, accountInput.extend({ profileId: id.nullable() }).strict(), (input) => accounts.create(input))
  handle(IpcChannel.AccountsUpdate, z.object({ id, input: accountInput }).strict(), ({ id: accountId, input }) => accounts.update(accountId, input))
  handle(IpcChannel.AccountsLink, z.object({ id, profileId: id }).strict(), ({ id: accountId, profileId }) => accounts.link(accountId, profileId))
  handle(IpcChannel.AccountsUnlink, ids, (accountIds) => accounts.unlink(accountIds))
  handle(IpcChannel.AccountsSetEnabled, z.object({ ids, enabled: z.boolean() }).strict(), ({ ids: accountIds, enabled }) =>
    accounts.setEnabled(accountIds, enabled)
  )
  handle(IpcChannel.AccountsRemove, ids, (accountIds) => accounts.remove(accountIds))
  handle(IpcChannel.AccountsCreateFromProfiles, ids, (profileIds) => accounts.createFromProfiles(profileIds))
  handle(IpcChannel.AccountsOpenProfile, id, (accountId) => accounts.openProfile(accountId))
  handle(IpcChannel.AccountsCloseProfile, id, (accountId) => accounts.closeProfile(accountId))

  // Backup & restore
  handle(IpcChannel.BackupCreate, noPayload, (_input, event) => backup.create(windowOf(event)))
  handle(IpcChannel.BackupInspectFile, noPayload, (_input, event) => backup.inspectFile(windowOf(event)))
  handle(IpcChannel.BackupInspectRecovery, z.string().min(1).max(200), (recoveryId) => backup.inspectRecovery(recoveryId))
  handle(IpcChannel.BackupListRecovery, noPayload, () => backup.listRecovery())
  handle(IpcChannel.BackupRestore, z.uuid(), async (token) => {
    await backup.restore(token)
    preferences.load()
  })
  handle(IpcChannel.BackupOpenFolder, noPayload, () => backup.openFolder())
  handle(IpcChannel.BackupStatus, noPayload, () => backup.status())
  handle(IpcChannel.BackupUpdateSettings, z.object({ schedule: z.enum(['off', 'daily', 'weekly']), keep: z.number().int().min(1).max(100) }).partial().strict(), (patch) =>
    backup.updateSettings(patch)
  )
  handle(IpcChannel.BackupChooseFolder, noPayload, (_input, event) => backup.chooseFolder(windowOf(event)))

  // Logs
  handle(
    IpcChannel.LogsList,
    z
      .object({ levels: z.array(logLevel).max(5).optional(), search: z.string().max(200).optional(), limit: z.number().int().min(1).max(5000).optional() })
      .strict()
      .optional(),
    (query) => logger.query(query)
  )
  handle(
    IpcChannel.LogsWrite,
    z
      .object({
        level: z.enum(['info', 'warning', 'error']),
        scope: z.string().trim().min(1).max(40),
        message: z.string().trim().min(1).max(2000)
      })
      .strict(),
    ({ level, scope, message }) => {
      logger.write(level, `ui:${scope}`, message)
    }
  )
  handle(IpcChannel.LogsClear, noPayload, () => {
    const removed = logger.clear()
    logger.write('warning', 'logs', 'Log history cleared', { removed })
    return removed
  })
  handle(IpcChannel.LogsExport, z.enum(['text', 'json']), async (format, event) => {
    const window = windowOf(event)
    const extension = format === 'json' ? 'json' : 'log'
    const options = {
      title: 'Export sanitized logs',
      defaultPath: `${app.getPath('documents')}/axora-relay-logs-${new Date().toISOString().slice(0, 10)}.${extension}`,
      filters: [{ name: format === 'json' ? 'JSON' : 'Log file', extensions: [extension] }]
    }
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { status: 'cancelled' as const }
    const count = await logger.exportTo(result.filePath, format)
    logger.write('info', 'logs', `Exported ${count} log entries`, { format })
    return { status: 'saved' as const, fileName: result.filePath.split(/[\\/]/).pop() ?? result.filePath, count }
  })

  // Scheduling, publishing and the task queue (Phase 8)
  const { publishing, queue, links, notifier } = services
  const isoTime = z.iso.datetime({ offset: true })
  const minutes = (max: number) => z.number().int().min(0).max(max)
  handle(IpcChannel.PublishingGetSettings, noPayload, () => publishing.getSettings())
  handle(
    IpcChannel.PublishingUpdateSettings,
    z
      .object({
        spacingMinutes: minutes(1440),
        missedGraceMinutes: minutes(1440),
        reminderMinutes: minutes(1440),
        closeProfileAfterPublish: z.boolean(),
        maxAttempts: z.number().int().min(1).max(5),
        retryDelayMinutes: z.number().int().min(1).max(60)
      })
      .partial()
      .strict(),
    (patch) => publishing.updateSettings(patch)
  )
  handle(IpcChannel.PublishingCheck, z.object({ draftId: id, accountId: id.nullable(), runAt: isoTime.optional(), scheduleId: id.optional() }).strict(), ({ draftId, accountId, runAt, scheduleId }) =>
    publishing.check(draftId, accountId, runAt, scheduleId ?? null)
  )
  handle(IpcChannel.PublishingSchedule, z.object({ draftId: id, accountId: id, runAt: isoTime }).strict(), (input) => publishing.schedule(input))
  handle(IpcChannel.PublishingPublishNow, z.object({ draftId: id, accountId: id }).strict(), (input) => publishing.publishNow(input))
  handle(
    IpcChannel.PublishingScheduleMany,
    z.object({ draftId: id, accountIds: z.array(id).min(1).max(50), runAt: isoTime.nullable(), allowSameText: z.boolean() }).strict(),
    (input) => publishing.scheduleMany(input)
  )
  handle(IpcChannel.PublishingReschedule, z.object({ id, runAt: isoTime }).strict(), ({ id: scheduleId, runAt }) => publishing.reschedule(scheduleId, runAt))
  handle(IpcChannel.PublishingUnschedule, id, (scheduleId) => publishing.unschedule(scheduleId))
  handle(IpcChannel.PublishingReturnToDrafts, id, (draftId) => publishing.returnToDrafts(draftId))
  handle(
    IpcChannel.PublishingResolveMissed,
    z
      .object({
        id,
        action: z.discriminatedUnion('action', [
          z.object({ action: z.literal('publish-now') }).strict(),
          z.object({ action: z.literal('reschedule'), runAt: isoTime }).strict(),
          z.object({ action: z.literal('cancel') }).strict()
        ])
      })
      .strict(),
    ({ id: scheduleId, action }) => publishing.resolveMissed(scheduleId, action)
  )
  handle(
    IpcChannel.PublishingList,
    z
      .object({ view: z.enum(['upcoming', 'attention', 'history', 'all']), from: isoTime.optional(), to: isoTime.optional(), accountId: id.optional() })
      .strict(),
    (query) => publishing.list(query)
  )
  handle(IpcChannel.PublishingNext, noPayload, () => publishing.next())
  handle(IpcChannel.PublishingForDraft, id, (draftId) => publishing.forDraft(draftId))
  handle(IpcChannel.PublishingCounts, noPayload, () => publishing.counts())
  const { control, usage, runs, automationSchedules } = services
  const itemIds = z.array(id).min(1).max(1000)
  handle(IpcChannel.RunsPlan, automationConfigSchema, (config) => runs.plan(config as AutomationConfig))
  handle(IpcChannel.RunsStart, z.object({ config: automationConfigSchema, presetId: id.nullable() }).strict(), ({ config, presetId }) => runs.start(config as AutomationConfig, presetId))
  handle(IpcChannel.RunsList, noPayload, () => runs.list())
  handle(IpcChannel.RunsDetails, id, (runId) => runs.details(runId))
  handle(IpcChannel.RunsActive, noPayload, () => runs.active())
  handle(IpcChannel.RunsPause, id, (runId) => runs.pause(runId))
  handle(IpcChannel.RunsResume, id, (runId) => runs.resume(runId))
  handle(IpcChannel.RunsStop, id, (runId) => runs.stop(runId))
  handle(IpcChannel.RunsSetMode, z.object({ id, mode: z.enum(['full-auto', 'manual-approval']) }).strict(), ({ id: runId, mode }) => runs.setMode(runId, mode))
  handle(IpcChannel.RunsApprove, z.object({ id, itemIds }).strict(), ({ id: runId, itemIds: ids }) => runs.approve(runId, ids))
  handle(IpcChannel.RunsRemove, z.object({ id, itemIds }).strict(), ({ id: runId, itemIds: ids }) => runs.remove(runId, ids))
  handle(IpcChannel.RunsRegenerate, z.object({ id, itemId: id }).strict(), ({ id: runId, itemId }) => runs.regenerate(runId, itemId))
  handle(IpcChannel.PresetsList, noPayload, () => runs.listPresets())
  handle(IpcChannel.PresetsSave, z.object({ id: id.optional(), name: z.string().trim().min(1).max(80), config: automationConfigSchema }).strict(), (input) =>
    runs.savePreset({ ...input, config: input.config as AutomationConfig })
  )
  handle(IpcChannel.PresetsRemove, id, (presetId) => runs.removePreset(presetId))
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  handle(IpcChannel.AutomationSchedulesList, noPayload, () => automationSchedules.list())
  handle(
    IpcChannel.AutomationSchedulesSave,
    z
      .object({
        id: id.optional(),
        name: z.string().trim().min(1).max(80),
        config: automationConfigSchema,
        presetId: id.nullable(),
        startDate: day,
        endDate: day.nullable(),
        days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        windowStart: hhmm,
        windowEnd: hhmm
      })
      .strict(),
    (input) => automationSchedules.save({ ...input, config: input.config as AutomationConfig })
  )
  handle(IpcChannel.AutomationSchedulesRemove, id, (scheduleId) => automationSchedules.remove(scheduleId))
  handle(IpcChannel.AutomationSchedulesPause, id, (scheduleId) => automationSchedules.pause(scheduleId))
  handle(IpcChannel.AutomationSchedulesResume, id, (scheduleId) => automationSchedules.resume(scheduleId))
  const money = z.number().min(0).max(100_000).nullable()
  handle(
    IpcChannel.UsageReport,
    z.object({ from: isoTime, to: isoTime, providerId: id.optional(), operation: z.enum(['connection-test', 'list-models', 'generate-text', 'generate-image']).optional() }).strict(),
    (query) => usage.report(query)
  )
  handle(IpcChannel.UsageRates, noPayload, () => usage.listRates())
  handle(
    IpcChannel.UsageSaveRate,
    z.object({ id: id.optional(), providerId: id, model: z.string().trim().max(120).nullable(), inputPerMillion: money, outputPerMillion: money, perImage: money, note: z.string().max(300) }).strict(),
    (input) => usage.saveRate(input)
  )
  handle(IpcChannel.UsageRemoveRate, id, (rateId) => usage.removeRate(rateId))
  handle(IpcChannel.UsageLimits, noPayload, () => usage.listLimits())
  handle(
    IpcChannel.UsageSaveLimit,
    z
      .object({
        id: id.optional(),
        providerId: id.nullable(),
        period: z.enum(['day', 'month']),
        metric: z.enum(['requests', 'tokens', 'images', 'estimated-cost']),
        threshold: z.number().positive().max(1e12),
        action: z.enum(['warn', 'block'])
      })
      .strict(),
    (input) => usage.saveLimit(input)
  )
  handle(IpcChannel.UsageRemoveLimit, id, (limitId) => usage.removeLimit(limitId))
  handle(IpcChannel.ControlSnapshot, noPayload, () => control.snapshot())
  handle(IpcChannel.ControlPause, noPayload, () => control.pause())
  handle(IpcChannel.ControlResume, noPayload, () => control.resume())
  handle(IpcChannel.ControlStopNow, noPayload, () => control.stopNow())
  handle(IpcChannel.ControlHold, id, (taskId) => control.hold(taskId))
  handle(IpcChannel.ControlRelease, id, (taskId) => control.release(taskId))
  handle(IpcChannel.QueueList, z.object({ view: z.enum(['active', 'attention', 'done', 'all']), limit: z.number().int().min(1).max(500).optional() }).strict(), (query) =>
    queue.list(query)
  )
  handle(IpcChannel.QueueDetails, id, (taskId) => queue.details(taskId))
  handle(IpcChannel.QueueCounts, noPayload, () => queue.counts())
  handle(IpcChannel.QueueCancel, id, (taskId) => queue.cancel(taskId))
  handle(IpcChannel.QueueRetry, id, (taskId) => publishing.retryTask(taskId))
  handle(
    IpcChannel.QueueResolveReview,
    z.discriminatedUnion('outcome', [
      z.object({ taskId: id, outcome: z.literal('posted'), url: z.string().trim().max(500).nullable() }).strict(),
      z.object({ taskId: id, outcome: z.literal('not-posted') }).strict()
    ]),
    (resolution) => publishing.resolveReview(resolution.outcome === 'posted' ? { ...resolution, url: resolution.url || null } : resolution)
  )
  // Post links and engagement tasks (Phase 9)
  const { engagement } = services
  const tagList = z.array(z.string().max(60)).max(20)
  const engagementKind = z.enum(['reply', 'like', 'repost', 'quote', 'bookmark', 'follow-up', 'other'])
  const engagementFields = {
    accountId: id.nullable(),
    kind: engagementKind,
    dueAt: isoTime.nullable(),
    note: z.string().max(1000),
    replyText: z.string().max(4000)
  }
  handle(IpcChannel.LinksList, noPayload, () => links.list())
  handle(IpcChannel.LinksAdd, z.object({ text: z.string().max(600_000), accountId: id.nullable(), tags: tagList, notes: z.string().max(2000) }).strict(), (input) => links.add(input))
  handle(
    IpcChannel.LinksUpdate,
    z.object({ id, update: z.object({ accountId: id.nullable(), tags: tagList, notes: z.string().max(2000) }).strict() }).strict(),
    ({ id: linkId, update }) => links.update(linkId, update)
  )
  handle(IpcChannel.LinksAddTags, z.object({ ids: z.array(id).min(1).max(5000), tags: tagList.min(1) }).strict(), ({ ids, tags }) => links.addTags(ids, tags))
  handle(IpcChannel.LinksRemove, z.array(id).min(1).max(5000), (ids) => links.remove(ids))
  handle(IpcChannel.LinksImport, noPayload, async (_input, event) => {
    const window = windowOf(event)
    const options = {
      title: 'Import post links',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Link lists (TXT, CSV)', extensions: ['txt', 'csv'] }]
    }
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return { added: [], duplicates: [], rejected: [], cancelled: true }
    const path = picked.filePaths[0]
    const info = await stat(path)
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new ValidationError('Choose a TXT or CSV file under 2 MB.')
    const result = links.importText(await readFile(path, 'utf8'))
    return { ...result, cancelled: false, fileName: path.split(/[\\/]/).pop() }
  })
  handle(IpcChannel.LinksExport, z.array(id).max(5000).nullable(), async (ids, event) => {
    const window = windowOf(event)
    const options = {
      title: 'Export post links',
      defaultPath: `${app.getPath('documents')}/axora-relay-post-links-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    }
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { cancelled: true }
    const { csv, count } = links.exportCsv(ids ?? undefined)
    await writeFile(result.filePath, csv, 'utf8')
    return { cancelled: false, fileName: result.filePath.split(/[\\/]/).pop(), count }
  })
  handle(IpcChannel.EngagementList, z.object({ status: z.enum(['open', 'done', 'skipped', 'all']), accountId: id.optional(), linkId: id.optional() }).strict(), (query) => engagement.list(query))
  handle(IpcChannel.EngagementCounts, noPayload, () => engagement.counts())
  handle(IpcChannel.EngagementCheck, z.object({ linkIds: z.array(id).min(1).max(500), ...engagementFields }).strict(), (input) => engagement.checkMany(input))
  handle(IpcChannel.EngagementCreate, z.object({ linkIds: z.array(id).min(1).max(500), ...engagementFields }).strict(), (input) => engagement.create(input))
  handle(IpcChannel.EngagementUpdate, z.object({ id, update: z.object(engagementFields).strict() }).strict(), ({ id: taskId, update }) => engagement.update(taskId, update))
  handle(IpcChannel.EngagementSetStatus, z.object({ ids: z.array(id).min(1).max(2000), status: z.enum(['open', 'done', 'skipped']) }).strict(), ({ ids, status }) => engagement.setStatus(ids, status))
  handle(IpcChannel.EngagementRemove, z.array(id).min(1).max(2000), (ids) => engagement.remove(ids))
  handle(IpcChannel.EngagementOpenInProfile, id, (taskId) => engagement.openInProfile(taskId))
  handle(IpcChannel.EngagementGetSettings, noPayload, () => engagement.getSettings())
  handle(IpcChannel.EngagementUpdateSettings, z.object({ dailyLimitPerAccount: z.number().int().min(0).max(500) }).partial().strict(), (patch) => engagement.updateSettings(patch))
  handle(IpcChannel.NoticesReady, noPayload, () => notifier.rendererListening())

  // Shell
  handle(
    IpcChannel.ShellOpenExternal,
    z.string().max(2048).refine(isSafeExternalUrl, 'Only https:// links can be opened.'),
    (url) => shell.openExternal(url)
  )
}
