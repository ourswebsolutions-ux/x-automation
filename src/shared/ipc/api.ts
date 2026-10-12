import type {
  Account,
  AccountCreateInput,
  AccountDetails,
  AccountInput,
  BulkResult,
  CreateFromProfilesResult
} from '../types/accounts'
import type {
  AiConnectionTest,
  AiModelList,
  AiOverview,
  AiUsageQuery,
  AiUsageRecord,
  AiUsageSummary,
  TestPromptInput,
  TestPromptOutcome
} from '../types/ai'
import type { Draft, DraftInput, Id, WorkspaceSummary } from '../types/domain'
import type { AppNotice } from '../types/notifications'
import type { UpdateStatus } from '../types/updates'
import type { AutomationConfig, AutomationMode, AutomationRun, AutomationSchedule, AutomationScheduleInput, PromptPreset, RunDetails, RunItem, RunPlan } from '../types/automation'
import type { UsageLimit, UsageLimitInput, UsageQuery, UsageRate, UsageRateInput, UsageReport } from '../types/usage'
import type {
  EngagementCheck,
  EngagementCreateResult,
  EngagementInput,
  EngagementQuery,
  EngagementSettings,
  EngagementStatus,
  EngagementTaskView,
  EngagementUpdate,
  LinkAddInput,
  LinkAddResult,
  LinkExportResult,
  LinkImportResult,
  LinkUpdate,
  PostLinkView
} from '../types/links'
import type {
  MissedAction,
  PublishCheck,
  PublishingSettings,
  MultiScheduleInput,
  PublishAllCheck,
  PublishAllInput,
  PublishTargets,
  MultiScheduleResult,
  PublishNowInput,
  QueueCounts,
  QueueQuery,
  ReviewResolution,
  ScheduleEntry,
  ScheduleInput,
  ScheduleQuery,
  AutomationSnapshot,
  TaskDetails,
  TaskView
} from '../types/publishing'
import type { CompatibilityResult, EngineSelfCheck, EngineStatus } from '../types/engine'
import type { Proxy, ProxyAssignment, ProxyExportResult, ProxyImportResult, ProxyInput, ProxyTest } from '../types/proxies'
import type {
  AssetQuery,
  ImageAsset,
  ImageGenerationRecord,
  ImageGenerationRequest,
  ImagePromptOutcome,
  ImagePromptRequest,
  ImageRunOptions,
  ImportResult
} from '../types/images'
import type { AssistRequest, GenerationBrief, GenerationHistoryQuery, GenerationRecord, GenerationRunOptions } from '../types/generator'
import type {
  BrowserProfile,
  ConnectionTestResult,
  IxBrowserOverview,
  ProfileOperationResult,
  SyncProgress,
  SyncRun
} from '../types/ixbrowser'
import type { IntegrationStatus } from '../types/integrations'
import type { Preferences, PreferencesPatch } from '../types/preferences'
import type { ProviderConfig, ProviderInput, ProviderKind } from '../types/providers'
import type {
  BackupCreateResult,
  BackupInspection,
  BackupSettings,
  BackupStatus,
  CredentialStatus,
  DatabaseInfo,
  FileExportResult,
  HealthReport,
  RecoveryBackup
} from '../types/storage'
import type { AppInfo, LogEntry, LogQuery, SecurityPosture, WindowState } from '../types/system'

export type Unsubscribe = () => void

/**
 * The complete surface exposed to the renderer as `window.relay`.
 * The renderer has no other path to Node.js or Electron APIs.
 */
export interface RelayApi {
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    getState(): Promise<WindowState>
    onStateChange(listener: (state: WindowState) => void): Unsubscribe
  }
  app: {
    getInfo(): Promise<AppInfo>
    getSecurityPosture(): Promise<SecurityPosture>
    /** Synchronously known platform, used for window chrome decisions. */
    platform: string
  }
  /** Application updates from GitHub Releases — nothing is downloaded or installed without the user. */
  updates: {
    status(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    download(): Promise<UpdateStatus>
    /** Restarts into the downloaded update; refused while automation is running. */
    install(): Promise<void>
    openReleasePage(): Promise<void>
    onChange(listener: (status: UpdateStatus) => void): Unsubscribe
  }
  preferences: {
    get(): Promise<Preferences>
    update(patch: PreferencesPatch): Promise<Preferences>
    reset(): Promise<Preferences>
    onChange(listener: (preferences: Preferences) => void): Unsubscribe
  }
  integrations: {
    list(): Promise<IntegrationStatus[]>
    onChange(listener: () => void): Unsubscribe
  }
  providers: {
    list(kind?: ProviderKind): Promise<ProviderConfig[]>
    create(input: ProviderInput): Promise<ProviderConfig>
    update(id: Id, input: ProviderInput): Promise<ProviderConfig>
    remove(id: Id): Promise<void>
    /** Write-only. The key is encrypted in the main process and never returned. */
    setKey(id: Id, secret: string): Promise<ProviderConfig>
    removeKey(id: Id): Promise<ProviderConfig>
  }
  credentials: {
    status(): Promise<CredentialStatus>
    clearAll(): Promise<number>
  }
  database: {
    info(): Promise<DatabaseInfo>
    healthCheck(): Promise<HealthReport>
    compact(): Promise<DatabaseInfo>
    openFolder(): Promise<void>
  }
  /** IX Browser Local API V2 — all network calls run in the main process. */
  ixbrowser: {
    overview(): Promise<IxBrowserOverview>
    /** Sends a real profile-list request. Pass a provider id to test a specific configuration. */
    testConnection(providerId?: Id): Promise<ConnectionTestResult>
    sync(): Promise<SyncRun>
    cancelSync(): Promise<boolean>
    profiles(): Promise<BrowserProfile[]>
    syncHistory(): Promise<SyncRun[]>
    refreshStatus(): Promise<BrowserProfile[]>
    openProfile(externalId: number): Promise<ProfileOperationResult>
    closeProfile(externalId: number): Promise<ProfileOperationResult>
    onSyncProgress(listener: (progress: SyncProgress) => void): Unsubscribe
  }
  /**
   * Local X account records (Phase 4). Nothing here contacts X: identities are
   * what the user entered or confirmed, and enable/disable is a local setting.
   */
  accounts: {
    list(): Promise<Account[]>
    details(id: Id): Promise<AccountDetails>
    create(input: AccountCreateInput): Promise<Account>
    update(id: Id, input: AccountInput): Promise<Account>
    /** Links to an available profile no other account uses (re-links if already linked). */
    link(id: Id, profileId: Id): Promise<Account>
    /** Removes associations only; browser profiles are never changed. */
    unlink(ids: Id[]): Promise<BulkResult>
    setEnabled(ids: Id[], enabled: boolean): Promise<BulkResult>
    /** Deletes local records only; browser profiles are never deleted. */
    remove(ids: Id[]): Promise<BulkResult>
    createFromProfiles(profileIds: Id[]): Promise<CreateFromProfilesResult>
    /** Connects a disconnected profile again (re-links its previous account when it still exists). */
    connectProfile(profileId: Id): Promise<Account>
    openProfile(id: Id): Promise<ProfileOperationResult>
    closeProfile(id: Id): Promise<ProfileOperationResult>
    onChange(listener: () => void): Unsubscribe
  }
  /**
   * AI text providers (Phase 5). Requests run in the main process with keys
   * the renderer never sees. Only these specific operations are exposed —
   * there is no general-purpose proxy.
   */
  ai: {
    overview(): Promise<AiOverview>
    /** Real GET /models with the saved key; free of charge. */
    testConnection(providerId: Id): Promise<AiConnectionTest>
    /** The last fetched list (null if never fetched), or a fresh GET /models with `refresh`. */
    listModels(providerId: Id, refresh?: boolean): Promise<AiModelList | null>
    /** Short prompt with a small output cap, for checking generation works. Billed by the provider. */
    testPrompt(input: TestPromptInput): Promise<TestPromptOutcome>
    cancel(requestId: Id): Promise<boolean>
    usage(query?: AiUsageQuery): Promise<AiUsageRecord[]>
    usageSummary(query?: AiUsageQuery): Promise<AiUsageSummary>
  }
  /**
   * Local image library (Phase 7). Files are chosen in a main-process dialog
   * and stored in an app-managed folder; the renderer only ever sees ids and
   * relay-asset:// URLs.
   */
  assets: {
    list(query?: AssetQuery): Promise<ImageAsset[]>
    /** Opens a file dialog; each file is validated by content. */
    import(): Promise<ImportResult>
    /** Keeps a generated image in the library. */
    keep(id: Id): Promise<ImageAsset>
    /** Refused while a draft attaches the image. */
    remove(id: Id): Promise<void>
    stats(): Promise<{ count: number; bytes: number; folder: string }>
    openFolder(): Promise<void>
  }
  /** Image generation (Phase 7). Cancel with ai.cancel(requestId). */
  images: {
    generate(request: ImageGenerationRequest, options: ImageRunOptions): Promise<ImageGenerationRecord>
    history(limit?: number): Promise<ImageGenerationRecord[]>
    /** Uses the text provider to propose an image prompt for a post; never changes the post. */
    suggestPrompt(input: ImagePromptRequest): Promise<ImagePromptOutcome>
  }
  /**
   * The Python + Playwright automation engine. It runs as a child process of
   * the app (no network port) and is started on demand.
   */
  engine: {
    status(): Promise<EngineStatus>
    start(): Promise<EngineStatus>
    restart(): Promise<EngineStatus>
    stop(): Promise<EngineStatus>
    /** Starts the engine and Playwright's driver for real. */
    selfCheck(): Promise<EngineSelfCheck>
    lastSelfCheck(): Promise<EngineSelfCheck | null>
    openDiagnostics(): Promise<void>
  }
  automation: {
    /** Opens the profile through IX Browser, attaches over CDP and drives a controlled test page. */
    checkProfile(profileId: Id): Promise<CompatibilityResult>
    lastResult(profileId: Id): Promise<CompatibilityResult | null>
  }
  /** Proxy manager. Passwords are write-only: they are encrypted and never returned. */
  proxies: {
    list(): Promise<Proxy[]>
    create(input: ProxyInput): Promise<Proxy>
    update(id: Id, input: ProxyInput): Promise<Proxy>
    remove(id: Id): Promise<void>
    setDefault(id: Id | null): Promise<void>
    test(id: Id): Promise<ProxyTest>
    /** Opens a file dialog (TXT or CSV). */
    import(defaultScheme?: ProxyInput['scheme']): Promise<ProxyImportResult>
    /** Opens a save dialog. Passwords are never exported. */
    export(format: 'txt' | 'csv'): Promise<ProxyExportResult>
    assignments(): Promise<ProxyAssignment[]>
    assign(profileIds: Id[], proxyId: Id): Promise<BulkResult>
    /** Local only — IX Browser keeps the profile's current proxy setting. */
    unassign(profileIds: Id[]): Promise<BulkResult>
    applyDefault(): Promise<BulkResult>
  }
  /** Scheduling and publishing (Phase 8). */
  publishing: {
    getSettings(): Promise<PublishingSettings>
    updateSettings(patch: Partial<PublishingSettings>): Promise<PublishingSettings>
    /** What stands between a draft and publishing it (blocking problems and warnings). */
    /** scheduleId: the schedule being changed (so it does not count as a conflict). */
    check(draftId: Id, accountId: Id | null, runAt?: string, scheduleId?: Id): Promise<PublishCheck>
    schedule(input: ScheduleInput): Promise<ScheduleEntry>
    publishNow(input: PublishNowInput): Promise<ScheduleEntry>
    /** One manual post from several accounts (copies for the extra accounts). */
    scheduleMany(input: MultiScheduleInput): Promise<MultiScheduleResult>
    /** Every account that can post now (enabled, synced profile available) — no selection needed. */
    targets(): Promise<PublishTargets>
    /** The post checked against every eligible account (runAt: when scheduling). */
    checkAll(draftId: Id, runAt?: string): Promise<PublishAllCheck>
    /** Publishes now or schedules the post from every eligible account. */
    publishAll(input: PublishAllInput): Promise<MultiScheduleResult>
    reschedule(id: Id, runAt: string): Promise<ScheduleEntry>
    unschedule(id: Id): Promise<void>
    returnToDrafts(draftId: Id): Promise<void>
    resolveMissed(id: Id, action: MissedAction): Promise<ScheduleEntry | null>
    list(query: ScheduleQuery): Promise<ScheduleEntry[]>
    next(): Promise<ScheduleEntry | null>
    /** The draft's most recent schedule (any status), with its task. */
    forDraft(draftId: Id): Promise<ScheduleEntry | null>
    counts(): Promise<{ upcoming: number; attention: number }>
    /** Queue, schedules or post links changed. */
    onChange(listener: () => void): Unsubscribe
  }
  /** Usage & costs over recorded AI requests. Costs are estimates from rates you enter. */
  usage: {
    report(query: UsageQuery): Promise<UsageReport>
    rates(): Promise<UsageRate[]>
    saveRate(input: UsageRateInput): Promise<UsageRate>
    removeRate(id: Id): Promise<void>
    limits(): Promise<UsageLimit[]>
    saveLimit(input: UsageLimitInput): Promise<UsageLimit>
    removeLimit(id: Id): Promise<void>
  }
  /** Automation runs (Phase 12): plan → one confirmation → start; approvals in Manual Approval mode. */
  runs: {
    plan(config: AutomationConfig): Promise<RunPlan>
    start(config: AutomationConfig, presetId?: Id | null): Promise<AutomationRun>
    list(): Promise<AutomationRun[]>
    details(id: Id): Promise<RunDetails>
    active(): Promise<AutomationRun | null>
    pause(id: Id): Promise<AutomationRun>
    resume(id: Id): Promise<AutomationRun>
    stop(id: Id): Promise<AutomationRun>
    setMode(id: Id, mode: AutomationMode): Promise<AutomationRun>
    approve(id: Id, itemIds: Id[]): Promise<{ approved: number; failed: { id: Id; reason: string }[] }>
    remove(id: Id, itemIds: Id[]): Promise<number>
    regenerate(id: Id, itemId: Id): Promise<RunItem>
  }
  presets: {
    list(): Promise<PromptPreset[]>
    save(input: { id?: Id; name: string; config: AutomationConfig }): Promise<PromptPreset>
    remove(id: Id): Promise<void>
  }
  /** Recurring automation schedules: one run per chosen day inside daily hours (separate from post schedules). */
  automationSchedules: {
    list(): Promise<AutomationSchedule[]>
    save(input: AutomationScheduleInput): Promise<AutomationSchedule>
    remove(id: Id): Promise<void>
    pause(id: Id): Promise<AutomationSchedule>
    resume(id: Id): Promise<AutomationSchedule>
  }
  /** Automation control centre (Phase 10). */
  control: {
    snapshot(): Promise<AutomationSnapshot>
    /** No new task starts until resumed (kept across restarts). */
    pause(): Promise<AutomationSnapshot>
    resume(): Promise<AutomationSnapshot>
    /** Pauses and stops the running task at its next safe point. */
    stopNow(): Promise<AutomationSnapshot>
    hold(taskId: Id): Promise<void>
    release(taskId: Id): Promise<void>
  }
  queue: {
    list(query: QueueQuery): Promise<TaskView[]>
    details(id: Id): Promise<TaskDetails>
    counts(): Promise<QueueCounts>
    /** Waiting tasks are cancelled at once; a running one stops only at a safe point. */
    cancel(id: Id): Promise<'cancelled' | 'stopping'>
    retry(id: Id): Promise<void>
    resolveReview(resolution: ReviewResolution): Promise<void>
  }
  /** Post links — local records; removing one never touches the post on X. */
  links: {
    list(): Promise<PostLinkView[]>
    add(input: LinkAddInput): Promise<LinkAddResult>
    update(id: Id, update: LinkUpdate): Promise<PostLinkView>
    addTags(ids: Id[], tags: string[]): Promise<BulkResult>
    remove(ids: Id[]): Promise<BulkResult>
    /** Opens a file dialog (TXT or CSV). */
    import(): Promise<LinkImportResult>
    /** Opens a save dialog; all links, or only `ids`. */
    export(ids?: Id[]): Promise<LinkExportResult>
  }
  /** Engagement tasks — a checklist. X Auto never likes, reposts, replies or follows by itself. */
  engagement: {
    list(query: EngagementQuery): Promise<EngagementTaskView[]>
    counts(): Promise<{ open: number; overdue: number }>
    check(input: EngagementInput): Promise<EngagementCheck[]>
    create(input: EngagementInput): Promise<EngagementCreateResult>
    update(id: Id, update: EngagementUpdate): Promise<EngagementTaskView>
    setStatus(ids: Id[], status: EngagementStatus): Promise<BulkResult>
    remove(ids: Id[]): Promise<BulkResult>
    /** Opens the post in the task account's IX Browser profile for the user. */
    openInProfile(id: Id): Promise<{ signedOut: boolean }>
    getSettings(): Promise<EngagementSettings>
    updateSettings(patch: Partial<EngagementSettings>): Promise<EngagementSettings>
  }
  notices: {
    /** Starts delivery (including notices raised before the window was ready). */
    ready(): Promise<void>
    onNotice(listener: (notice: AppNotice) => void): Unsubscribe
    /** A desktop notification was clicked: open this route. */
    onNavigate(listener: (route: string) => void): Unsubscribe
  }
  /** File paths are chosen in native dialogs owned by the main process. */
  backup: {
    create(): Promise<BackupCreateResult>
    inspectFile(): Promise<BackupInspection>
    inspectRecovery(id: string): Promise<BackupInspection>
    listRecovery(): Promise<RecoveryBackup[]>
    restore(token: string): Promise<void>
    openFolder(): Promise<void>
    status(): Promise<BackupStatus>
    updateSettings(patch: Partial<Pick<BackupSettings, 'schedule' | 'keep'>>): Promise<BackupSettings>
    /** Opens a folder picker; null when cancelled. */
    chooseFolder(): Promise<BackupSettings | null>
  }
  workspace: {
    getSummary(): Promise<WorkspaceSummary>
  }
  drafts: {
    list(): Promise<Draft[]>
    save(input: DraftInput): Promise<Draft>
    duplicate(id: Id): Promise<Draft>
    remove(id: Id): Promise<void>
  }
  /**
   * Tweet generator and AI editing tools (Phase 6). Runs through the AI
   * service in the main process; failures come back as records with an error.
   * Cancel a running request with ai.cancel(requestId).
   */
  generator: {
    generate(brief: GenerationBrief, options: GenerationRunOptions): Promise<GenerationRecord>
    assist(request: AssistRequest, options: GenerationRunOptions): Promise<GenerationRecord>
    history(query?: GenerationHistoryQuery): Promise<GenerationRecord[]>
    get(id: Id): Promise<GenerationRecord>
  }
  logs: {
    list(query?: LogQuery): Promise<LogEntry[]>
    write(level: 'info' | 'warning' | 'error', scope: string, message: string): Promise<void>
    clear(): Promise<number>
    /** Opens a save dialog and writes a sanitized export. */
    export(format: 'text' | 'json'): Promise<FileExportResult>
    onAppend(listener: (entry: LogEntry) => void): Unsubscribe
  }
  shell: {
    /** Opens an https:// URL in the default browser. Other schemes are rejected. */
    openExternal(url: string): Promise<void>
  }
}
