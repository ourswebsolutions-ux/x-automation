import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { RelayApi, Unsubscribe } from '@shared/ipc/api'
import { IpcChannel, type IpcChannelName, IpcEvent, type IpcEventName, type IpcResult } from '@shared/ipc/channels'

/** Error type thrown into the renderer when the main process rejects a call. */
class RelayIpcError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'RelayIpcError'
  }
}

async function invoke<T>(channel: IpcChannelName, payload?: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>
  if (result.ok) return result.data
  // Encode the code in the message: Error subclasses lose fields across the bridge.
  throw new RelayIpcError(result.error.code, `[${result.error.code}] ${result.error.message}`)
}

/** One IPC listener per event channel, fanned out to every subscriber (a page may subscribe many times). */
const subscribers = new Map<IpcEventName, Set<{ fn: (payload: unknown) => void }>>()
function subscribe<T>(channel: IpcEventName, listener: (payload: T) => void): Unsubscribe {
  let set = subscribers.get(channel)
  if (!set) {
    const fresh = new Set<{ fn: (payload: unknown) => void }>()
    subscribers.set(channel, fresh)
    set = fresh
    // Never hand the raw IpcRendererEvent (and its `sender`) to the renderer.
    ipcRenderer.on(channel, (_event: IpcRendererEvent, payload: unknown) => {
      for (const entry of [...fresh]) entry.fn(payload)
    })
  }
  // Each subscription is its own entry, so subscribing the same function twice stays two subscriptions.
  const entry = { fn: listener as (payload: unknown) => void }
  const listeners = set
  listeners.add(entry)
  return () => {
    listeners.delete(entry)
  }
}

const api: RelayApi = {
  window: {
    minimize: () => invoke(IpcChannel.WindowMinimize),
    toggleMaximize: () => invoke(IpcChannel.WindowToggleMaximize),
    close: () => invoke(IpcChannel.WindowClose),
    getState: () => invoke(IpcChannel.WindowGetState),
    onStateChange: (listener) => subscribe(IpcEvent.WindowState, listener)
  },
  app: {
    getInfo: () => invoke(IpcChannel.AppGetInfo),
    getSecurityPosture: () => invoke(IpcChannel.AppGetSecurity),
    platform: process.platform
  },
  updates: {
    status: () => invoke(IpcChannel.UpdatesStatus),
    check: () => invoke(IpcChannel.UpdatesCheck),
    download: () => invoke(IpcChannel.UpdatesDownload),
    install: () => invoke(IpcChannel.UpdatesInstall),
    openReleasePage: () => invoke(IpcChannel.UpdatesOpenReleasePage),
    onChange: (listener) => subscribe(IpcEvent.UpdatesChanged, listener)
  },
  preferences: {
    get: () => invoke(IpcChannel.PreferencesGet),
    update: (patch) => invoke(IpcChannel.PreferencesUpdate, patch),
    reset: () => invoke(IpcChannel.PreferencesReset),
    onChange: (listener) => subscribe(IpcEvent.PreferencesChanged, listener)
  },
  integrations: {
    list: () => invoke(IpcChannel.IntegrationsList),
    onChange: (listener) => subscribe(IpcEvent.IntegrationsChanged, () => listener())
  },
  providers: {
    list: (kind) => invoke(IpcChannel.ProvidersList, kind),
    create: (input) => invoke(IpcChannel.ProvidersCreate, input),
    update: (id, input) => invoke(IpcChannel.ProvidersUpdate, { id, input }),
    remove: (id) => invoke(IpcChannel.ProvidersRemove, id),
    setKey: (id, secret) => invoke(IpcChannel.ProvidersSetKey, { id, secret }),
    removeKey: (id) => invoke(IpcChannel.ProvidersRemoveKey, id)
  },
  credentials: {
    status: () => invoke(IpcChannel.CredentialsStatus),
    clearAll: () => invoke(IpcChannel.CredentialsClearAll)
  },
  database: {
    info: () => invoke(IpcChannel.DatabaseInfo),
    healthCheck: () => invoke(IpcChannel.DatabaseHealth),
    compact: () => invoke(IpcChannel.DatabaseCompact),
    openFolder: () => invoke(IpcChannel.DatabaseOpenFolder)
  },
  ixbrowser: {
    overview: () => invoke(IpcChannel.IxOverview),
    testConnection: (providerId) => invoke(IpcChannel.IxTestConnection, providerId),
    sync: () => invoke(IpcChannel.IxSync),
    cancelSync: () => invoke(IpcChannel.IxCancelSync),
    profiles: () => invoke(IpcChannel.IxProfiles),
    syncHistory: () => invoke(IpcChannel.IxSyncHistory),
    refreshStatus: () => invoke(IpcChannel.IxRefreshStatus),
    openProfile: (externalId) => invoke(IpcChannel.IxOpenProfile, externalId),
    closeProfile: (externalId) => invoke(IpcChannel.IxCloseProfile, externalId),
    onSyncProgress: (listener) => subscribe(IpcEvent.IxSyncProgress, listener)
  },
  accounts: {
    list: () => invoke(IpcChannel.AccountsList),
    details: (id) => invoke(IpcChannel.AccountsDetails, id),
    create: (input) => invoke(IpcChannel.AccountsCreate, input),
    update: (id, input) => invoke(IpcChannel.AccountsUpdate, { id, input }),
    link: (id, profileId) => invoke(IpcChannel.AccountsLink, { id, profileId }),
    unlink: (ids) => invoke(IpcChannel.AccountsUnlink, ids),
    setEnabled: (ids, enabled) => invoke(IpcChannel.AccountsSetEnabled, { ids, enabled }),
    remove: (ids) => invoke(IpcChannel.AccountsRemove, ids),
    createFromProfiles: (profileIds) => invoke(IpcChannel.AccountsCreateFromProfiles, profileIds),
    connectProfile: (profileId) => invoke(IpcChannel.AccountsConnectProfile, profileId),
    openProfile: (id) => invoke(IpcChannel.AccountsOpenProfile, id),
    closeProfile: (id) => invoke(IpcChannel.AccountsCloseProfile, id),
    onChange: (listener) => subscribe(IpcEvent.AccountsChanged, () => listener())
  },
  ai: {
    overview: () => invoke(IpcChannel.AiOverview),
    testConnection: (providerId) => invoke(IpcChannel.AiTestConnection, providerId),
    listModels: (providerId, refresh) => invoke(IpcChannel.AiListModels, { providerId, refresh: refresh ?? false }),
    testPrompt: (input) => invoke(IpcChannel.AiTestPrompt, input),
    cancel: (requestId) => invoke(IpcChannel.AiCancel, requestId),
    usage: (query) => invoke(IpcChannel.AiUsageList, query),
    usageSummary: (query) => invoke(IpcChannel.AiUsageSummary, query)
  },
  assets: {
    list: (query) => invoke(IpcChannel.AssetsList, query),
    import: () => invoke(IpcChannel.AssetsImport),
    keep: (id) => invoke(IpcChannel.AssetsKeep, id),
    remove: (id) => invoke(IpcChannel.AssetsRemove, id),
    stats: () => invoke(IpcChannel.AssetsStats),
    openFolder: () => invoke(IpcChannel.AssetsOpenFolder)
  },
  images: {
    generate: (request, options) => invoke(IpcChannel.ImagesGenerate, { request, options }),
    history: (limit) => invoke(IpcChannel.ImagesHistory, limit),
    suggestPrompt: (input) => invoke(IpcChannel.ImagesSuggestPrompt, input)
  },
  engine: {
    status: () => invoke(IpcChannel.EngineStatus),
    start: () => invoke(IpcChannel.EngineStart),
    restart: () => invoke(IpcChannel.EngineRestart),
    stop: () => invoke(IpcChannel.EngineStop),
    selfCheck: () => invoke(IpcChannel.EngineSelfCheck),
    lastSelfCheck: () => invoke(IpcChannel.EngineLastSelfCheck),
    openDiagnostics: () => invoke(IpcChannel.EngineOpenDiagnostics)
  },
  automation: {
    checkProfile: (profileId) => invoke(IpcChannel.AutomationCheckProfile, profileId),
    lastResult: (profileId) => invoke(IpcChannel.AutomationLastResult, profileId)
  },
  proxies: {
    list: () => invoke(IpcChannel.ProxiesList),
    create: (input) => invoke(IpcChannel.ProxiesCreate, input),
    update: (id, input) => invoke(IpcChannel.ProxiesUpdate, { id, input }),
    remove: (id) => invoke(IpcChannel.ProxiesRemove, id),
    setDefault: (id) => invoke(IpcChannel.ProxiesSetDefault, id),
    test: (id) => invoke(IpcChannel.ProxiesTest, id),
    import: (defaultScheme) => invoke(IpcChannel.ProxiesImport, defaultScheme ?? 'http'),
    export: (format) => invoke(IpcChannel.ProxiesExport, format),
    assignments: () => invoke(IpcChannel.ProxiesAssignments),
    assign: (profileIds, proxyId) => invoke(IpcChannel.ProxiesAssign, { profileIds, proxyId }),
    unassign: (profileIds) => invoke(IpcChannel.ProxiesUnassign, profileIds),
    applyDefault: () => invoke(IpcChannel.ProxiesApplyDefault)
  },
  publishing: {
    getSettings: () => invoke(IpcChannel.PublishingGetSettings),
    updateSettings: (patch) => invoke(IpcChannel.PublishingUpdateSettings, patch),
    check: (draftId, accountId, runAt, scheduleId) => invoke(IpcChannel.PublishingCheck, { draftId, accountId, ...(runAt ? { runAt } : {}), ...(scheduleId ? { scheduleId } : {}) }),
    schedule: (input) => invoke(IpcChannel.PublishingSchedule, input),
    publishNow: (input) => invoke(IpcChannel.PublishingPublishNow, input),
    scheduleMany: (input) => invoke(IpcChannel.PublishingScheduleMany, input),
    targets: () => invoke(IpcChannel.PublishingTargets),
    checkAll: (draftId, runAt) => invoke(IpcChannel.PublishingCheckAll, { draftId, ...(runAt ? { runAt } : {}) }),
    publishAll: (input) => invoke(IpcChannel.PublishingPublishAll, input),
    reschedule: (id, runAt) => invoke(IpcChannel.PublishingReschedule, { id, runAt }),
    unschedule: (id) => invoke(IpcChannel.PublishingUnschedule, id),
    returnToDrafts: (draftId) => invoke(IpcChannel.PublishingReturnToDrafts, draftId),
    resolveMissed: (id, action) => invoke(IpcChannel.PublishingResolveMissed, { id, action }),
    list: (query) => invoke(IpcChannel.PublishingList, query),
    next: () => invoke(IpcChannel.PublishingNext),
    forDraft: (draftId) => invoke(IpcChannel.PublishingForDraft, draftId),
    counts: () => invoke(IpcChannel.PublishingCounts),
    onChange: (listener) => subscribe(IpcEvent.PublishingChanged, () => listener())
  },
  usage: {
    report: (query) => invoke(IpcChannel.UsageReport, query),
    rates: () => invoke(IpcChannel.UsageRates),
    saveRate: (input) => invoke(IpcChannel.UsageSaveRate, input),
    removeRate: (id) => invoke(IpcChannel.UsageRemoveRate, id),
    limits: () => invoke(IpcChannel.UsageLimits),
    saveLimit: (input) => invoke(IpcChannel.UsageSaveLimit, input),
    removeLimit: (id) => invoke(IpcChannel.UsageRemoveLimit, id)
  },
  runs: {
    plan: (config) => invoke(IpcChannel.RunsPlan, config),
    start: (config, presetId) => invoke(IpcChannel.RunsStart, { config, presetId: presetId ?? null }),
    list: () => invoke(IpcChannel.RunsList),
    details: (id) => invoke(IpcChannel.RunsDetails, id),
    active: () => invoke(IpcChannel.RunsActive),
    pause: (id) => invoke(IpcChannel.RunsPause, id),
    resume: (id) => invoke(IpcChannel.RunsResume, id),
    stop: (id) => invoke(IpcChannel.RunsStop, id),
    setMode: (id, mode) => invoke(IpcChannel.RunsSetMode, { id, mode }),
    approve: (id, itemIds) => invoke(IpcChannel.RunsApprove, { id, itemIds }),
    remove: (id, itemIds) => invoke(IpcChannel.RunsRemove, { id, itemIds }),
    regenerate: (id, itemId) => invoke(IpcChannel.RunsRegenerate, { id, itemId })
  },
  presets: {
    list: () => invoke(IpcChannel.PresetsList),
    save: (input) => invoke(IpcChannel.PresetsSave, input),
    remove: (id) => invoke(IpcChannel.PresetsRemove, id)
  },
  automationSchedules: {
    list: () => invoke(IpcChannel.AutomationSchedulesList),
    save: (input) => invoke(IpcChannel.AutomationSchedulesSave, input),
    remove: (id) => invoke(IpcChannel.AutomationSchedulesRemove, id),
    pause: (id) => invoke(IpcChannel.AutomationSchedulesPause, id),
    resume: (id) => invoke(IpcChannel.AutomationSchedulesResume, id)
  },
  control: {
    snapshot: () => invoke(IpcChannel.ControlSnapshot),
    pause: () => invoke(IpcChannel.ControlPause),
    resume: () => invoke(IpcChannel.ControlResume),
    stopNow: () => invoke(IpcChannel.ControlStopNow),
    hold: (taskId) => invoke(IpcChannel.ControlHold, taskId),
    release: (taskId) => invoke(IpcChannel.ControlRelease, taskId)
  },
  queue: {
    list: (query) => invoke(IpcChannel.QueueList, query),
    details: (id) => invoke(IpcChannel.QueueDetails, id),
    counts: () => invoke(IpcChannel.QueueCounts),
    cancel: (id) => invoke(IpcChannel.QueueCancel, id),
    retry: (id) => invoke(IpcChannel.QueueRetry, id),
    resolveReview: (resolution) => invoke(IpcChannel.QueueResolveReview, resolution)
  },
  links: {
    list: () => invoke(IpcChannel.LinksList),
    add: (input) => invoke(IpcChannel.LinksAdd, input),
    update: (id, update) => invoke(IpcChannel.LinksUpdate, { id, update }),
    addTags: (ids, tags) => invoke(IpcChannel.LinksAddTags, { ids, tags }),
    remove: (ids) => invoke(IpcChannel.LinksRemove, ids),
    import: () => invoke(IpcChannel.LinksImport),
    export: (ids) => invoke(IpcChannel.LinksExport, ids ?? null)
  },
  engagement: {
    list: (query) => invoke(IpcChannel.EngagementList, query),
    counts: () => invoke(IpcChannel.EngagementCounts),
    check: (input) => invoke(IpcChannel.EngagementCheck, input),
    create: (input) => invoke(IpcChannel.EngagementCreate, input),
    update: (id, update) => invoke(IpcChannel.EngagementUpdate, { id, update }),
    setStatus: (ids, status) => invoke(IpcChannel.EngagementSetStatus, { ids, status }),
    remove: (ids) => invoke(IpcChannel.EngagementRemove, ids),
    openInProfile: (id) => invoke(IpcChannel.EngagementOpenInProfile, id),
    getSettings: () => invoke(IpcChannel.EngagementGetSettings),
    updateSettings: (patch) => invoke(IpcChannel.EngagementUpdateSettings, patch)
  },
  notices: {
    ready: () => invoke(IpcChannel.NoticesReady),
    onNotice: (listener) => subscribe(IpcEvent.Notice, listener),
    onNavigate: (listener) => subscribe(IpcEvent.Navigate, listener)
  },
  backup: {
    create: () => invoke(IpcChannel.BackupCreate),
    inspectFile: () => invoke(IpcChannel.BackupInspectFile),
    inspectRecovery: (id) => invoke(IpcChannel.BackupInspectRecovery, id),
    listRecovery: () => invoke(IpcChannel.BackupListRecovery),
    restore: (token) => invoke(IpcChannel.BackupRestore, token),
    openFolder: () => invoke(IpcChannel.BackupOpenFolder),
    status: () => invoke(IpcChannel.BackupStatus),
    updateSettings: (patch) => invoke(IpcChannel.BackupUpdateSettings, patch),
    chooseFolder: () => invoke(IpcChannel.BackupChooseFolder)
  },
  workspace: {
    getSummary: () => invoke(IpcChannel.WorkspaceSummary)
  },
  drafts: {
    list: () => invoke(IpcChannel.DraftsList),
    save: (input) => invoke(IpcChannel.DraftsSave, input),
    duplicate: (id) => invoke(IpcChannel.DraftsDuplicate, id),
    remove: (id) => invoke(IpcChannel.DraftsRemove, id)
  },
  generator: {
    generate: (brief, options) => invoke(IpcChannel.GeneratorGenerate, { brief, options }),
    assist: (request, options) => invoke(IpcChannel.GeneratorAssist, { request, options }),
    history: (query) => invoke(IpcChannel.GeneratorHistory, query),
    get: (id) => invoke(IpcChannel.GeneratorGet, id)
  },
  logs: {
    list: (query) => invoke(IpcChannel.LogsList, query),
    write: (level, scope, message) => invoke(IpcChannel.LogsWrite, { level, scope, message }),
    clear: () => invoke(IpcChannel.LogsClear),
    export: (format) => invoke(IpcChannel.LogsExport, format),
    onAppend: (listener) => subscribe(IpcEvent.LogAppended, listener)
  },
  shell: {
    openExternal: (url) => invoke(IpcChannel.ShellOpenExternal, url)
  }
}

contextBridge.exposeInMainWorld('relay', api)
