import { app, Notification, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { UpdateService } from './updates/updateService'
import { createUpdater, detectUpdatePlatform } from './updates/platform'
import { AccountService } from './accounts/accountService'
import { AiService } from './ai/aiService'
import { AutomationService } from './engine/automationService'
import { EngineService } from './engine/engineService'
import { ProxyService } from './proxies/proxyService'
import { AssetService } from './assets/assetService'
import { ImageService } from './images/imageService'
import { GeneratorService } from './generator/generatorService'
import { BackupService } from './backup/backupService'
import { SafeStorageVault, type CredentialVault } from './credentials/credentialVault'
import { DatabaseService, defaultDatabasePath } from './database/databaseService'
import type { WorkspaceRepositories } from './database/repositories'
import { createSqliteRepositories } from './database/sqlite'
import { AccountRepository } from './database/sqlite/accountRepository'
import { AiUsageRepository } from './database/sqlite/aiUsageRepository'
import { AssetRepository } from './database/sqlite/assetRepository'
import { ProxyRepository } from './database/sqlite/proxyRepository'
import { ImageGenerationRepository } from './database/sqlite/imageGenerationRepository'
import { GenerationRepository } from './database/sqlite/generationRepository'
import { ProfileRepository } from './database/sqlite/profileRepository'
import { DraftService } from './drafts/draftService'
import { CommentDraftService } from './drafts/commentDraftService'
import type { ImageGenerationProvider } from './integrations/image/types'
import { IntegrationsService } from './integrations/integrationsService'
import { IxBrowserService } from './integrations/ixbrowser/ixBrowserService'
import { ProviderRegistry } from './integrations/providerRegistry'
import { Logger } from './logging/logger'
import { importLegacyPreferences } from './preferences/legacyImport'
import { PreferencesStore } from './preferences/preferencesStore'
import { ProviderService } from './providers/providerService'
import { WorkspaceService } from './workspace/workspaceService'
import type { SyncProgress } from '@shared/types/ixbrowser'
import type { AppNotice } from '@shared/types/notifications'
import { retryDelayMs } from '@shared/types/publishing'
import { PostLinkRepository } from './database/sqlite/postLinkRepository'
import { QueueRepository } from './database/sqlite/queueRepository'
import { ScheduleRepository } from './database/sqlite/scheduleRepository'
import { EngagementRepository } from './database/sqlite/engagementRepository'
import { EngagementService } from './links/engagementService'
import { LinkService } from './links/linkService'
import { Notifier } from './notifications/notifier'
import { PublishHandler } from './publishing/publishHandler'
import { PublishingService } from './publishing/publishingService'
import { Scheduler } from './publishing/scheduler'
import { QueueService } from './queue/queueService'
import { AutomationControlService } from './automation/controlService'
import { UsageService } from './usage/usageService'
import { AutomationScheduleService } from './automation/scheduleService'
import { RunService } from './automation/runService'

export interface AppServices {
  logger: Logger
  database: DatabaseService
  repositories: WorkspaceRepositories
  preferences: PreferencesStore
  vault: CredentialVault
  providers: ProviderService
  backup: BackupService
  ixBrowser: IxBrowserService
  accounts: AccountService
  /** AI text providers: connection tests, models, generation, usage (Phase 5). */
  ai: AiService
  /** Tweet generator and AI editing tools (Phase 6). */
  generator: GeneratorService
  /** Local image library (Phase 7). */
  assets: AssetService
  /** Image generation and prompt suggestions (Phase 7). */
  images: ImageService
  /** The Python + Playwright automation engine (child process, stdio protocol). */
  engine: EngineService
  /** Compatibility checks and other engine-backed browser work. */
  automation: AutomationService
  /** Proxy manager (passwords in the credential vault). */
  proxies: ProxyService
  /** User-facing notices (in-app and desktop). */
  notifier: Notifier
  /** Persistent task queue (Phase 8). */
  queue: QueueService
  /** Scheduling and publishing workflow (Phase 8). */
  publishing: PublishingService
  scheduler: Scheduler
  /** Automation control centre: pause / resume / stop, snapshot (Phase 10). */
  control: AutomationControlService
  /** Usage & cost tracking over recorded AI requests (Phase 11). */
  usage: UsageService
  /** Automation runs: generate → attach images → schedule/approve → publish (Phase 12). */
  runs: RunService
  /** Recurring automation schedules (days, daily hours, start/end dates) — separate from post schedules. */
  automationSchedules: AutomationScheduleService
  /** Post links (Phase 8 records them; Phase 9 manages them). */
  links: LinkService
  /** Engagement tasks — a checklist; nothing is done on X automatically (Phase 9). */
  engagement: EngagementService
  /** Desktop notification clicks (wired to the window by the main entry). */
  onNoticeClick: (listener: (notice: AppNotice) => void) => () => void
  /** Queue, schedules or post links changed. */
  onPublishingChanged: (listener: () => void) => () => void
  /** Application updates from GitHub Releases. */
  updates: UpdateService
  onUpdatesChanged: (listener: () => void) => () => void
  /** Image generation providers register here in Phase 7. */
  imageProviders: ProviderRegistry<ImageGenerationProvider>
  integrations: IntegrationsService
  workspace: WorkspaceService
  drafts: DraftService
  /** Saved comments for campaigns (bulk comments). */
  comments: CommentDraftService
  profiles: ProfileRepository
  /** Notified whenever provider configs, credentials or IX Browser state change. */
  onIntegrationsChanged: (listener: () => void) => () => void
  onSyncProgress: (listener: (progress: SyncProgress) => void) => () => void
  onAccountsChanged: (listener: () => void) => () => void
}

/**
 * Composition root. Opens the database, runs migrations, imports Phase 1
 * preferences once, then wires every service.
 */
export async function createServices(): Promise<AppServices> {
  const userData = app.getPath('userData')
  const logger = new Logger()

  const database = new DatabaseService(defaultDatabasePath(userData), logger.scope('database'))
  await database.open()
  const assetDir = join(userData, 'assets')
  const assetExists = (rel: string) => {
    const full = resolve(assetDir, rel)
    return full.startsWith(assetDir + sep) && existsSync(full)
  }
  const repositories = createSqliteRepositories(database.db, { assetExists })
  logger.attachStore(repositories.logs)

  const preferences = new PreferencesStore(repositories.settings, repositories.notificationPreferences, logger.scope('preferences'))
  if (preferences.isEmpty()) {
    await importLegacyPreferences(join(userData, 'preferences.json'), preferences, repositories.providers, logger.scope('preferences'))
  }
  preferences.load()

  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())

  const vault = new SafeStorageVault(join(userData, 'credentials.vault'), logger.scope('credentials'))
  const providers = new ProviderService({
    db: database.db,
    providers: repositories.providers,
    credentialRefs: repositories.credentialRefs,
    vault,
    preferences,
    log: logger.scope('providers'),
    onChange: notify
  })

  const profiles = new ProfileRepository(database.db)
  const progressListeners = new Set<(progress: SyncProgress) => void>()
  const ixBrowser = new IxBrowserService({
    providers,
    profiles,
    settings: repositories.settings,
    activity: repositories.activity,
    log: logger.scope('ixbrowser'),
    onChange: notify,
    onProgress: (progress) => progressListeners.forEach((listener) => listener(progress))
  })

  const ai = new AiService({
    providers,
    preferences,
    settings: repositories.settings,
    usage: new AiUsageRepository(database.db),
    log: logger.scope('ai'),
    onChange: notify
  })

  const assetRepo = new AssetRepository(database.db)
  const assets = new AssetService({ repo: assetRepo, dir: assetDir, log: logger.scope('assets'), onChange: notify })
  void assets.sweep().catch((error: unknown) => logger.scope('assets').error('Image clean-up failed', error))
  const images = new ImageService({
    ai,
    assets,
    providers,
    preferences,
    generations: new ImageGenerationRepository(database.db),
    log: logger.scope('images')
  })

  // Development runs from the repository; the installed app from its resources folder.
  const resourceRoot = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const runtimeDir = app.isPackaged ? join(resourceRoot, 'engine-runtime') : join(resourceRoot, 'engine-runtime', process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux')
  // Development/test only: AXORA_TEST_X_BASE_URL points publishing at a loopback stand-in for x.com.
  const testBaseUrl = !app.isPackaged && process.env.AXORA_TEST_X_BASE_URL ? process.env.AXORA_TEST_X_BASE_URL : null
  const engine = new EngineService({
    allowTestTargets: Boolean(testBaseUrl),
    paths: {
      engineDir: join(resourceRoot, 'engine'),
      pythonExe: process.platform === 'win32' ? join(runtimeDir, 'python', 'python.exe') : join(runtimeDir, 'python', 'bin', 'python3'),
      diagnosticsDir: join(userData, 'diagnostics')
    },
    log: logger.scope('engine'),
    onChange: notify
  })
  const automation = new AutomationService({ engine, ixBrowser, profiles, settings: repositories.settings, log: logger.scope('automation'), onChange: notify })
  const proxies = new ProxyService({
    repo: new ProxyRepository(database.db),
    vault,
    settings: repositories.settings,
    profiles,
    ixBrowser,
    log: logger.scope('proxies'),
    onChange: notify
  })

  const noticeClickListeners = new Set<(notice: AppNotice) => void>()
  const notifier = new Notifier({
    preferences,
    log: logger.scope('notifications'),
    desktop: (notice) => {
      if (!Notification.isSupported()) return false
      const toast = new Notification({ title: notice.title, body: notice.body ?? '' })
      toast.on('click', () => noticeClickListeners.forEach((listener) => listener(notice)))
      toast.show()
      return true
    }
  })

  const publishingListeners = new Set<() => void>()
  const publishingChanged = () => publishingListeners.forEach((listener) => listener())
  const queueRepo = new QueueRepository(database.db)
  const testBackoff = !app.isPackaged && process.env.AXORA_TEST_QUEUE_BACKOFF_MS ? Number(process.env.AXORA_TEST_QUEUE_BACKOFF_MS) : null
  // The publishing service is created below; the queue reads its retry delay lazily.
  let retryDelay: (attempt: number) => number = () => 60_000
  const queue = new QueueService({
    repo: queueRepo,
    settings: repositories.settings,
    log: logger.scope('queue'),
    onChange: publishingChanged,
    backoffMs: testBackoff ? () => testBackoff : (attempt) => retryDelay(attempt)
  })
  const schedules = new ScheduleRepository(database.db)
  const postLinks = new PostLinkRepository(database.db)
  const accountRepo = new AccountRepository(database.db)
  const publishing = new PublishingService({
    db: database.db,
    drafts: repositories.drafts,
    accounts: accountRepo,
    schedules,
    postLinks,
    queue,
    queueRepo,
    // Called only at run time, after the draft service below exists.
    duplicateDraft: (id) => drafts.duplicate(id),
    settings: repositories.settings,
    activity: repositories.activity,
    notifier,
    log: logger.scope('publishing'),
    onChange: publishingChanged
  })
  retryDelay = (attempt) => retryDelayMs(publishing.getSettings(), attempt)
  const publishDeps: ConstructorParameters<typeof PublishHandler>[0] = {
    drafts: repositories.drafts,
    accounts: accountRepo,
    postLinks,
    queueRepo,
    ixBrowser,
    engine,
    assetFile: (id) => assets.fileFor(id)?.path ?? null,
    settings: () => publishing.getSettings(),
    settle: (task, settlement) => publishing.settleTask(task, settlement),
    log: logger.scope('publishing'),
    notifier,
    testBaseUrl
  }
  queue.register(new PublishHandler(publishDeps))
  // Comments saved with a post: the same account replies to its own confirmed post.
  queue.register(new PublishHandler(publishDeps, 'reply'))
  // Campaign reposts: performed in the account's profile and confirmed from the post's own state on X.
  queue.register(new PublishHandler(publishDeps, 'repost'))
  const scheduler = new Scheduler({
    db: database.db,
    schedules,
    accounts: accountRepo,
    publishing,
    settings: () => publishing.getSettings(),
    notifier,
    log: logger.scope('scheduler'),
    onChange: publishingChanged
  })

  const usage = new UsageService({ db: database.db, notifier, log: logger.scope('usage'), onChange: notify })
  ai.setUsageGuard(usage)
  const control = new AutomationControlService({ queue, queueRepo, schedules, accounts: accountRepo, engine, scheduler, notifier, log: logger.scope('automation') })

  const accountListeners = new Set<() => void>()
  const accounts = new AccountService({
    accounts: accountRepo,
    profiles,
    ixBrowser,
    log: logger.scope('accounts'),
    onChange: () => accountListeners.forEach((listener) => listener())
  })

  const generator = new GeneratorService({
    ai,
    providers,
    preferences,
    generations: new GenerationRepository(database.db),
    log: logger.scope('generator')
  })
  const drafts = new DraftService(repositories, database.db, assetRepo, logger.scope('drafts'), assetExists)
  const comments = new CommentDraftService(database.db, logger.scope('comments'))
  const engagement = new EngagementService({
    repo: new EngagementRepository(database.db),
    links: postLinks,
    accounts: accountRepo,
    settings: repositories.settings,
    ixBrowser,
    engine,
    log: logger.scope('engagement'),
    onChange: publishingChanged,
    testBaseUrl
  })
  const runs = new RunService({
    db: database.db,
    generator,
    images,
    drafts,
    comments,
    assets: assetRepo,
    accounts: accountRepo,
    accountService: accounts,
    profiles,
    providers,
    preferences,
    publishing,
    engagement,
    queue,
    notifier,
    log: logger.scope('runs'),
    onChange: publishingChanged
  })
  const automationSchedules = new AutomationScheduleService({ db: database.db, runs, notifier, log: logger.scope('automation-schedules'), onChange: publishingChanged })

  // Application updates (GitHub Releases). How this copy can be updated depends on how it was installed.
  const updateLog = logger.scope('updates')
  const updateEnv = { isPackaged: app.isPackaged, platform: process.platform, execPath: process.execPath, resourcesPath: process.resourcesPath, productName: app.getName(), env: process.env }
  const updatePlatform = detectUpdatePlatform(updateEnv)
  const updater =
    updatePlatform.mode === 'disabled'
      ? null
      : await createUpdater(updateEnv, { info: (m) => updateLog.info(m), warn: (m) => updateLog.warn(m), error: (m) => updateLog.error(m) }).catch((error: unknown) => {
          updateLog.error('The updater could not be started', error)
          return null
        })
  const updatesListeners = new Set<() => void>()
  const updates = new UpdateService({
    updater,
    mode: updatePlatform.mode,
    modeReason: updater ? updatePlatform.reason : (updatePlatform.reason ?? 'The updater could not be started.'),
    currentVersion: app.getVersion(),
    feed: updatePlatform.feed,
    automationBusy: () => {
      if (queue.current()) return 'A post is being published right now. Install the update when it has finished (or pause automation first).'
      if (runs.active()?.status === 'generating') return 'An automation run is preparing posts. Pause it, or install the update when it has finished.'
      return null
    },
    beforeInstall: async () => {
      // Scheduled posts and runs are kept in the database and continue after the restart.
      scheduler.stop()
      automationSchedules.stop()
      await queue.stop()
      const state = engine.status().state
      if (state === 'ready' || state === 'starting') await engine.stop('update')
    },
    openExternal: async (url) => {
      if (!url.startsWith('https://github.com/')) throw new Error('Only GitHub release pages can be opened.')
      await shell.openExternal(url)
    },
    settings: repositories.settings,
    notifier,
    log: updateLog,
    onChange: () => updatesListeners.forEach((listener) => listener())
  })

  return {
    logger,
    database,
    repositories,
    preferences,
    vault,
    providers,
    backup: new BackupService({
      database,
      settings: repositories.settings,
      assetDir,
      recoveryDir: join(userData, 'backups'),
      workDir: join(userData, 'tmp'),
      notifier,
      log: logger.scope('backup'),
      onChange: notify,
      beforeRestore: async () => {
        scheduler.stop()
        automationSchedules.stop()
        await queue.stop()
      },
      afterRestore: () => {
        queue.reloadState()
        scheduler.prepare()
        queue.start()
        scheduler.start()
        automationSchedules.start()
      }
    }),
    ixBrowser,
    ai,
    assets,
    images,
    engine,
    automation,
    proxies,
    notifier,
    queue,
    publishing,
    scheduler,
    control,
    usage,
    runs,
    automationSchedules,
    links: new LinkService({ repo: postLinks, accounts: accountRepo, log: logger.scope('links'), onChange: publishingChanged }),
    engagement,
    onNoticeClick: (listener) => {
      noticeClickListeners.add(listener)
      return () => noticeClickListeners.delete(listener)
    },
    onPublishingChanged: (listener) => {
      publishingListeners.add(listener)
      return () => publishingListeners.delete(listener)
    },
    updates,
    onUpdatesChanged: (listener) => {
      updatesListeners.add(listener)
      return () => updatesListeners.delete(listener)
    },
    generator,
    accounts,
    profiles,
    imageProviders: new ProviderRegistry<ImageGenerationProvider>(),
    integrations: new IntegrationsService({ providers, vault, database, ixBrowser, ai, preferences }),
    workspace: new WorkspaceService(repositories, profiles, queue, schedules),
    drafts,
    comments,
    onIntegrationsChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onSyncProgress: (listener) => {
      progressListeners.add(listener)
      return () => progressListeners.delete(listener)
    },
    onAccountsChanged: (listener) => {
      accountListeners.add(listener)
      return () => accountListeners.delete(listener)
    }
  }
}
