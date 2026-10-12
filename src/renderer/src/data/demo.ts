/**
 * DEMO DATASET — for previewing the interface only.
 *
 * Nothing here comes from a real account, browser profile or API. Every
 * record id starts with "demo-" and every screen that renders this data shows
 * a "Demo data" marker. Toggle it off in Settings → General.
 */
import type { ActivityEvent, Draft, Task, WorkspaceSummary } from '@shared/types/domain'

const now = Date.now()
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString()

/** Sample accounts referenced by demo tasks, drafts and activity. Not the Phase 4 account model. */
export interface DemoAccount {
  id: string
  handle: string
  displayName: string
  group: string
  status: 'active' | 'paused' | 'attention' | 'unlinked'
  browserProfileId: string | null
  lastActiveAt: string | null
  tags: string[]
}

export const DEMO_ACCOUNTS: DemoAccount[] = [
  ['ridgeline_coffee', 'Ridgeline Coffee', 'Brands', 'active', 12, ['retail']],
  ['tidewater_labs', 'Tidewater Labs', 'Brands', 'active', 34, ['saas', 'b2b']],
  ['quietharbor', 'Quiet Harbor', 'Community', 'active', 58, ['community']],
  ['ferrous_print', 'Ferrous Print Co.', 'Brands', 'attention', 140, ['retail']],
  ['northpine_dev', 'Northpine Dev', 'Tech', 'active', 9, ['tech']],
  ['lowtide_audio', 'Lowtide Audio', 'Tech', 'paused', 2_880, ['audio']],
  ['marigold_reads', 'Marigold Reads', 'Community', 'active', 76, ['books']],
  ['basalt_outdoor', 'Basalt Outdoor', 'Brands', 'active', 210, ['outdoor']],
  ['cinder_studio', 'Cinder Studio', 'Tech', 'unlinked', null, ['design']],
  ['palewave_fm', 'Palewave FM', 'Community', 'attention', 410, ['radio']],
  ['oakmoss_home', 'Oakmoss Home', 'Brands', 'active', 25, ['home']],
  ['slate_and_ink', 'Slate & Ink', 'Community', 'unlinked', null, ['writing']]
].map(([handle, displayName, group, status, lastActive, tags], index) => ({
  id: `demo-acc-${index + 1}`,
  handle: handle as string,
  displayName: displayName as string,
  group: group as string,
  status: status as DemoAccount['status'],
  browserProfileId: status === 'unlinked' ? null : `demo-profile-${1040 + index}`,
  lastActiveAt: lastActive === null ? null : minutesAgo(lastActive as number),
  tags: tags as string[]
}))

const handleOf = (id: string) => DEMO_ACCOUNTS.find((account) => account.id === id)?.handle ?? null

const demoTask = (task: Pick<Task, 'id' | 'kind' | 'status' | 'accountId' | 'label' | 'attempts' | 'createdAt' | 'finishedAt' | 'error'>): Task => ({
  draftId: null,
  scheduleId: null,
  maxAttempts: 3,
  runAfter: task.createdAt,
  startedAt: task.status === 'queued' ? null : task.createdAt,
  errorCode: null,
  result: null,
  held: false,
  ...task
})

export const DEMO_TASKS: Task[] = [
  demoTask({ id: 'demo-task-1', kind: 'publish', status: 'running', accountId: 'demo-acc-2', label: 'Weekly product changelog', attempts: 1, createdAt: minutesAgo(2), finishedAt: null, error: null }),
  demoTask({ id: 'demo-task-2', kind: 'generate-text', status: 'queued', accountId: 'demo-acc-1', label: 'Morning post variants', attempts: 0, createdAt: minutesAgo(4), finishedAt: null, error: null }),
  demoTask({ id: 'demo-task-3', kind: 'reply', status: 'queued', accountId: 'demo-acc-3', label: 'Reply to community thread', attempts: 0, createdAt: minutesAgo(6), finishedAt: null, error: null }),
  demoTask({ id: 'demo-task-4', kind: 'publish', status: 'succeeded', accountId: 'demo-acc-5', label: 'Release notes v2.4', attempts: 1, createdAt: minutesAgo(22), finishedAt: minutesAgo(21), error: null }),
  demoTask({ id: 'demo-task-5', kind: 'generate-image', status: 'succeeded', accountId: 'demo-acc-8', label: 'Trail guide header image', attempts: 1, createdAt: minutesAgo(48), finishedAt: minutesAgo(47), error: null }),
  demoTask({ id: 'demo-task-6', kind: 'publish', status: 'failed', accountId: 'demo-acc-4', label: 'Spring catalogue teaser', attempts: 3, createdAt: minutesAgo(95), finishedAt: minutesAgo(88), error: 'Browser profile did not respond within 30s' }),
  demoTask({ id: 'demo-task-7', kind: 'sync-profiles', status: 'succeeded', accountId: null, label: 'Profile sync', attempts: 1, createdAt: minutesAgo(130), finishedAt: minutesAgo(129), error: null }),
  demoTask({ id: 'demo-task-8', kind: 'publish', status: 'cancelled', accountId: 'demo-acc-6', label: 'Podcast episode 41', attempts: 0, createdAt: minutesAgo(300), finishedAt: minutesAgo(290), error: null }),
  demoTask({ id: 'demo-task-9', kind: 'publish', status: 'queued', accountId: 'demo-acc-7', label: 'Book club announcement', attempts: 0, createdAt: minutesAgo(8), finishedAt: null, error: null }),
  demoTask({ id: 'demo-task-10', kind: 'reply', status: 'succeeded', accountId: 'demo-acc-11', label: 'Customer question follow-up', attempts: 2, createdAt: minutesAgo(360), finishedAt: minutesAgo(355), error: null }),
]

export const DEMO_ACTIVITY: ActivityEvent[] = [
  { id: 'demo-act-1', level: 'info', message: 'Publishing started', subject: '@tidewater_labs', at: minutesAgo(2) },
  { id: 'demo-act-2', level: 'success', message: 'Post published', subject: '@northpine_dev', at: minutesAgo(21) },
  { id: 'demo-act-3', level: 'success', message: 'Image generated for draft', subject: '@basalt_outdoor', at: minutesAgo(47) },
  { id: 'demo-act-4', level: 'error', message: 'Publishing failed after 3 attempts', subject: '@ferrous_print', at: minutesAgo(88) },
  { id: 'demo-act-5', level: 'warning', message: 'Profile needs re-authentication', subject: '@palewave_fm', at: minutesAgo(110) },
  { id: 'demo-act-6', level: 'success', message: '10 browser profiles synced', subject: null, at: minutesAgo(129) },
  { id: 'demo-act-7', level: 'info', message: '4 posts scheduled for tomorrow', subject: '@marigold_reads', at: minutesAgo(200) }
]

export const DEMO_DRAFTS: Draft[] = [
  {
    id: 'demo-draft-1',
    body: 'Small-batch Ethiopian Guji is back this week. Bright, floral, a little jammy — pour-over recommended. ☕',
    accountId: 'demo-acc-1',
    status: 'ready',
    origin: 'ai',
    hashtags: [],
    sourceGenerationId: null,
    media: [],
    comment: { enabled: false, text: '' },
    createdAt: minutesAgo(70),
    updatedAt: minutesAgo(40)
  },
  {
    id: 'demo-draft-2',
    body: 'We rebuilt our sync engine from scratch. Here is what we learned about conflict resolution at scale 🧵',
    accountId: 'demo-acc-2',
    status: 'draft',
    origin: 'manual',
    hashtags: [],
    sourceGenerationId: null,
    media: [],
    comment: { enabled: false, text: '' },
    createdAt: minutesAgo(180),
    updatedAt: minutesAgo(150)
  },
  {
    id: 'demo-draft-3',
    body: 'This month’s pick: a quiet novel about lighthouse keepers. Discussion thread opens Friday.',
    accountId: 'demo-acc-7',
    status: 'draft',
    origin: 'manual',
    hashtags: [],
    sourceGenerationId: null,
    media: [],
    comment: { enabled: false, text: '' },
    createdAt: minutesAgo(600),
    updatedAt: minutesAgo(560)
  }
]

export const DEMO_SUMMARY: WorkspaceSummary = {
  profiles: DEMO_ACCOUNTS.filter((account) => account.browserProfileId).length,
  drafts: 18,
  scheduled: 7,
  pendingTasks: DEMO_TASKS.filter((task) => task.status === 'queued' || task.status === 'running').length,
  recentActivity: DEMO_ACTIVITY,
  recentTasks: DEMO_TASKS.slice(0, 6)
}

/** Extra context lines shown under dashboard metrics in demo mode. */
export const DEMO_HINTS = {
  profiles: `of ${DEMO_ACCOUNTS.length} accounts · 2 need attention`,
  drafts: '5 ready to schedule',
  scheduled: 'Next in 1h 40m',
  pendingTasks: '1 running · 3 queued'
}

export function demoAccountHandle(accountId: string | null): string | null {
  return accountId ? handleOf(accountId) : null
}
