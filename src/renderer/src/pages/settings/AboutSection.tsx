import { ErrorState, SettingsSection, Skeleton } from '@/components/ui'
import { BrandMark } from '@/layout/BrandMark'
import { useSystem } from '@/state/system'

export function AboutSection() {
  const { appInfo } = useSystem()
  const info = appInfo.data

  const rows: [string, string][] = info
    ? [
        ['Version', info.version],
        ['Release phase', `Phase ${info.phase} — foundation`],
        ['Build', info.isPackaged ? 'Packaged' : 'Development'],
        ['Platform', `${info.platform} · ${info.arch}`],
        ['Electron', info.versions.electron],
        ['Chromium', info.versions.chrome],
        ['Node.js', info.versions.node]
      ]
    : []

  return (
    <SettingsSection title="About">
      <div className="flex items-center gap-4 px-4 py-5">
        <BrandMark size={44} />
        <div className="flex flex-col">
          <span className="text-lg font-semibold tracking-[-0.01em] text-fg">X Auto</span>
          <span className="text-sm text-fg-subtle">Desktop workspace for X accounts, drafts and automation.</span>
        </div>
      </div>
      {appInfo.status === 'error' ? (
        <ErrorState size="sm" error={appInfo.error} onRetry={appInfo.reload} />
      ) : (
        <dl className="grid grid-cols-1 gap-x-8 px-4 py-2 @2xl:grid-cols-2">
          {info
            ? rows.map(([label, value]) => (
                <div key={label} className="flex h-10 items-center justify-between gap-4 border-b border-line">
                  <dt className="text-sm text-fg-muted">{label}</dt>
                  <dd data-selectable className="tabular font-mono text-xs text-fg">
                    {value}
                  </dd>
                </div>
              ))
            : Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="flex h-10 items-center justify-between border-b border-line">
                  <Skeleton className="h-2.5 w-20" />
                  <Skeleton className="h-2.5 w-24" />
                </div>
              ))}
        </dl>
      )}
    </SettingsSection>
  )
}
