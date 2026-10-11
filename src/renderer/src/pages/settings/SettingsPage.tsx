import { ArchiveRestore, Bell, Bot, Cpu, Gauge, Globe, Paintbrush, Shield, ShieldCheck, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { PageHeader } from '@/components/ui'
import { cn } from '@/lib/cn'
import { NAV_ITEMS, resolveSettingsSection, type SettingsSectionId } from '@/app/navigation'
import { AiProvidersSection } from './AiProvidersSection'
import { AutomationSection } from './AutomationSection'
import { AppearanceSection } from './AppearanceSection'
import { BackupSection } from './BackupSection'
import { GeneralSection } from './GeneralSection'
import { ImageSection } from './ImageSection'
import { IxBrowserSection } from './IxBrowserSection'
import { NotificationsSection } from './NotificationsSection'
import { ProxySettingsSection } from './ProxySettingsSection'
import { SystemSection } from './SystemSection'
import { UsageSection } from './UsageSection'

interface Section {
  id: SettingsSectionId
  label: string
  icon: LucideIcon
  render: () => ReactNode
}

const GROUPS: { label: string; sections: Section[] }[] = [
  {
    label: 'Application',
    sections: [
      { id: 'general', label: 'General', icon: SlidersHorizontal, render: () => <GeneralSection /> },
      { id: 'appearance', label: 'Appearance', icon: Paintbrush, render: () => <AppearanceSection /> },
      { id: 'notifications', label: 'Notifications', icon: Bell, render: () => <NotificationsSection /> },
      { id: 'automation', label: 'Automation', icon: Cpu, render: () => <AutomationSection /> }
    ]
  },
  {
    label: 'Connections',
    sections: [
      {
        id: 'ai',
        label: 'AI providers & keys',
        icon: Bot,
        render: () => (
          <>
            <AiProvidersSection />
            <ImageSection />
          </>
        )
      },
      { id: 'ixbrowser', label: 'IX Browser', icon: Globe, render: () => <IxBrowserSection /> },
      { id: 'proxies', label: 'Proxies', icon: Shield, render: () => <ProxySettingsSection /> }
    ]
  },
  {
    label: 'Data',
    sections: [
      { id: 'usage', label: 'Usage & costs', icon: Gauge, render: () => <UsageSection /> },
      { id: 'backup', label: 'Backup & restore', icon: ArchiveRestore, render: () => <BackupSection /> }
    ]
  },
  {
    label: 'System',
    sections: [{ id: 'security', label: 'Security & app info', icon: ShieldCheck, render: () => <SystemSection /> }]
  }
]

const SECTIONS = GROUPS.flatMap((group) => group.sections)

export function SettingsPage() {
  const [params, setParams] = useSearchParams()
  const wanted = resolveSettingsSection(params.get('section'))
  const active = SECTIONS.find((section) => section.id === wanted) ?? SECTIONS[0]!

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={NAV_ITEMS.settings.label} description={NAV_ITEMS.settings.description} />
      <div className="grid grid-cols-1 gap-6 @3xl:grid-cols-[200px_minmax(0,1fr)] @3xl:gap-10">
        <nav aria-label="Settings sections" className="flex gap-4 overflow-x-auto @3xl:sticky @3xl:top-0 @3xl:flex-col @3xl:self-start">
          {GROUPS.map((group) => (
            <div key={group.label} className="flex shrink-0 gap-0.5 @3xl:flex-col">
              <span className="hidden px-2.5 pb-1 text-2xs font-medium uppercase tracking-[0.08em] text-fg-faint @3xl:block">
                {group.label}
              </span>
              {group.sections.map(({ id, label, icon: Icon }) => {
            const selected = id === active.id
            return (
              <button
                key={id}
                type="button"
                aria-current={selected ? 'page' : undefined}
                onClick={() => setParams({ section: id }, { replace: true })}
                className={cn(
                  'flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors focus-ring',
                  selected ? 'bg-surface-3 text-fg shadow-raised' : 'text-fg-muted hover:bg-neutral-soft hover:text-fg'
                )}
              >
                <Icon size={15} strokeWidth={1.8} className={selected ? 'text-accent-text' : 'text-fg-subtle'} />
                {label}
              </button>
            )
              })}
            </div>
          ))}
        </nav>
        <div key={active.id} className="flex max-w-3xl min-w-0 flex-col gap-8 animate-rise">
          {active.render()}
        </div>
      </div>
    </div>
  )
}
