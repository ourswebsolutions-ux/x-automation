import {
  CalendarClock,
  CalendarRange,
  FileText,
  LayoutDashboard,
  Link2,
  ListChecks,
  Settings,
  Sparkles,
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
  generator: {
    id: 'generator',
    path: '/generator',
    label: 'AI Tweet Generator',
    description: 'Generate post variations with your AI provider, then refine them as drafts',
    icon: Sparkles,
    keywords: ['ai', 'openai', 'generate', 'write', 'image']
  },
  posts: {
    id: 'posts',
    path: '/posts',
    label: 'Posts & Drafts',
    description: 'Write, edit and organise posts before publishing',
    icon: FileText,
    keywords: ['drafts', 'compose', 'tweets', 'write']
  },
  automation: {
    id: 'automation',
    path: '/automation',
    label: 'Automation',
    description: 'Describe the posts you want, choose profiles and start',
    icon: Workflow,
    keywords: ['run', 'start', 'full auto', 'approval', 'presets', 'workflow', 'generate']
  },
  schedules: {
    id: 'schedules',
    path: '/automation-schedule',
    label: 'Automation Schedule',
    description: 'Run an automation on chosen days and hours, between two dates',
    icon: CalendarRange,
    keywords: ['recurring', 'daily', 'weekly', 'days', 'working hours', 'automation schedule', 'repeat']
  },
  scheduler: {
    id: 'scheduler',
    path: '/scheduler',
    label: 'Scheduler',
    description: 'Plan when posts go out, per account',
    icon: CalendarClock,
    keywords: ['calendar', 'schedule', 'timing']
  },
  queue: {
    id: 'queue',
    path: '/queue',
    label: 'Task Queue',
    description: 'Running, queued and finished automation tasks',
    icon: ListChecks,
    keywords: ['tasks', 'jobs', 'automation', 'running']
  },
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
  { label: 'Create', items: [NAV_ITEMS.generator, NAV_ITEMS.posts] },
  { label: 'Automate', items: [NAV_ITEMS.automation, NAV_ITEMS.schedules, NAV_ITEMS.scheduler, NAV_ITEMS.queue] },
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
