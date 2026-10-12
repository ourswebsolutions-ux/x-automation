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
    label: 'Synchronized Profiles',
    description: 'Sync your IX Browser profiles — each one is linked to an account automatically and used by Create Post and Campaigns',
    icon: UsersRound,
    keywords: ['profiles', 'sync', 'ix browser', 'accounts', 'handles', 'users', 'proxies']
  },
  create: {
    id: 'create',
    path: '/create',
    label: 'Create Post',
    description: 'Write a post yourself or with AI, add images and a comment, then publish it now, schedule it, or save it for a campaign',
    icon: SquarePen,
    keywords: ['write', 'compose', 'draft', 'ai', 'generate', 'manual', 'image', 'comment', 'reply', 'publish', 'schedule', 'tweet', 'post']
  },
  campaigns: {
    id: 'campaigns',
    path: '/campaigns',
    label: 'Campaigns',
    description: 'Post saved posts from every synchronized profile now or at a date and time, and follow the results',
    icon: Workflow,
    keywords: ['campaign', 'automation', 'schedule', 'start', 'pause', 'stop', 'queue', 'repost', 'comment', 'results']
  },
  // Merged pages: their old addresses lead to the page that now holds them (not shown in navigation).
  generator: { id: 'generator', path: '/create?mode=ai', label: 'Create Post', description: 'Generate a post with AI', icon: Sparkles, keywords: [] },
  posts: { id: 'posts', path: '/create', label: 'Create Post', description: 'Write and edit posts', icon: FileText, keywords: [] },
  automation: { id: 'automation', path: '/campaigns', label: 'Campaigns', description: 'Campaigns', icon: Workflow, keywords: [] },
  schedules: { id: 'schedules', path: '/campaigns', label: 'Campaigns', description: 'Recurring campaigns', icon: CalendarRange, keywords: [] },
  scheduler: { id: 'scheduler', path: '/campaigns?view=queue', label: 'Campaigns', description: 'Scheduled posts', icon: CalendarClock, keywords: [] },
  queue: { id: 'queue', path: '/campaigns?view=queue', label: 'Campaigns', description: 'Posting queue', icon: ListChecks, keywords: [] },
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
  { label: 'Workspace', items: [NAV_ITEMS.dashboard] },
  { label: 'Automation', items: [NAV_ITEMS.create, NAV_ITEMS.campaigns, NAV_ITEMS.accounts] },
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
