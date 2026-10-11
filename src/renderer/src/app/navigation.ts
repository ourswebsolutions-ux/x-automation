import {
  CalendarClock,
  CalendarRange,
  FileText,
  LayoutDashboard,
  Link2,
  ListChecks,
  Settings,
  Sparkles,
  SquarePen,
  UsersRound,
  Workflow,
  type LucideIcon
} from 'lucide-react'
import type { RouteId } from '@shared/config/navigation'

export interface NavItem {
  id: RouteId
  path: `/${string}`
  label: string
  description: string
  icon: LucideIcon
  keywords: string[]
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const NAV_ITEMS: Record<RouteId, NavItem> = {
  dashboard: {
    id: 'dashboard',
    path: '/dashboard',
    label: 'Dashboard',
    description: 'Workspace overview, activity and system health',
    icon: LayoutDashboard,
    keywords: ['home', 'overview', 'summary']
  },
  accounts: {
    id: 'accounts',
    path: '/accounts',
    label: 'Accounts & Profiles',
    description: 'X accounts and their IX Browser profiles',
    icon: UsersRound,
    keywords: ['profiles', 'ix browser', 'handles', 'users']
  },
  create: {
    id: 'create',
    path: '/create',
    label: 'Create Post',
    description: 'Write a post yourself or with AI, add an image, then publish it or save it for a campaign',
    icon: SquarePen,
    keywords: ['write', 'compose', 'draft', 'ai', 'generate', 'manual', 'image', 'publish', 'tweet', 'post']
  },
  campaigns: {
    id: 'campaigns',
    path: '/campaigns',
    label: 'Campaign Automation',
    description: 'Choose saved posts and accounts, set the schedule, and start, pause or stop campaigns',
    icon: Workflow,
    keywords: ['campaign', 'automation', 'schedule', 'start', 'pause', 'stop', 'queue', 'recurring', 'days', 'interval']
  },
  // Merged pages: their old addresses lead to the page that now holds them (not shown in navigation).
  generator: { id: 'generator', path: '/create?mode=ai', label: 'Create Post', description: 'Generate a post with AI', icon: Sparkles, keywords: [] },
  posts: { id: 'posts', path: '/create', label: 'Create Post', description: 'Write and edit posts', icon: FileText, keywords: [] },
  automation: { id: 'automation', path: '/campaigns', label: 'Campaign Automation', description: 'Campaigns', icon: Workflow, keywords: [] },
  schedules: { id: 'schedules', path: '/campaigns', label: 'Campaign Automation', description: 'Recurring campaigns', icon: CalendarRange, keywords: [] },
  scheduler: { id: 'scheduler', path: '/campaigns?view=queue', label: 'Campaign Automation', description: 'Scheduled posts', icon: CalendarClock, keywords: [] },
  queue: { id: 'queue', path: '/campaigns?view=queue', label: 'Campaign Automation', description: 'Posting queue', icon: ListChecks, keywords: [] },
  links: {
    id: 'links',
    path: '/links',
    label: 'Post Links',
    description: 'Links to everything published from this workspace',
    icon: Link2,
    keywords: ['urls', 'published', 'links']
  },
  settings: {
    id: 'settings',
    path: '/settings',
    label: 'Settings',
    description: 'Preferences, integrations and security',
    icon: Settings,
    keywords: ['preferences', 'api', 'keys', 'config', 'theme']
  }
}

export const NAV_GROUPS: NavGroup[] = [
  { label: 'Workspace', items: [NAV_ITEMS.dashboard, NAV_ITEMS.accounts] },
  { label: 'Automation', items: [NAV_ITEMS.create, NAV_ITEMS.campaigns] },
  { label: 'Insights', items: [NAV_ITEMS.links] }
]

/** Navigation order used for Ctrl+1…9 shortcuts. */
export const NAV_ORDER: NavItem[] = [...NAV_GROUPS.flatMap((group) => group.items), NAV_ITEMS.settings]

export type SettingsSectionId = 'general' | 'appearance' | 'notifications' | 'automation' | 'ai' | 'ixbrowser' | 'proxies' | 'usage' | 'backup' | 'security'

/** Sections that were merged keep working as links. */
const SETTINGS_ALIASES: Record<string, SettingsSectionId> = { publishing: 'automation', providers: 'ai', image: 'ai', database: 'security', about: 'security' }
const SETTINGS_IDS: SettingsSectionId[] = ['general', 'appearance', 'notifications', 'automation', 'ai', 'ixbrowser', 'proxies', 'usage', 'backup', 'security']

export function resolveSettingsSection(id: string | null): SettingsSectionId {
  if (!id) return 'general'
  return SETTINGS_IDS.includes(id as SettingsSectionId) ? (id as SettingsSectionId) : (SETTINGS_ALIASES[id] ?? 'general')
}

export const settingsPath = (section: SettingsSectionId) => `/settings?section=${section}`
