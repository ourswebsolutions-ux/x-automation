import { LiveBadge, Panel, Skeleton, StatusBadge, type Tone } from '@/components/ui'
import { useSystem } from '@/state/system'

interface Row {
  label: string
  value: string
  tone?: Tone
}

export function SystemPanel() {
  const { appInfo, security, integrations } = useSystem()
  const storage = integrations.data?.find((item) => item.id === 'database')

  const rows: Row[] | null =
    appInfo.data && security.data
      ? [
          { label: 'Version', value: `${appInfo.data.version}${appInfo.data.isPackaged ? '' : ' (dev)'}` },
          { label: 'Runtime', value: `Electron ${appInfo.data.versions.electron.split('.')[0]}` },
          {
            label: 'Renderer isolation',
            value: security.data.contextIsolation && security.data.sandbox && !security.data.nodeIntegration ? 'Enforced' : 'Weak',
            tone: security.data.contextIsolation && security.data.sandbox ? 'success' : 'danger'
          },
          {
            label: 'Key storage',
            value: security.data.credentialEncryptionAvailable ? 'Protected' : 'Unavailable',
            tone: security.data.credentialEncryptionAvailable ? 'success' : 'warning'
          },
          { label: 'Storage', value: storage?.state === 'available' ? 'SQLite' : 'Needs attention', tone: storage?.state === 'available' ? 'success' : 'warning' }
        ]
      : null

  return (
    <Panel title="System status" meta={<LiveBadge />} padded={false}>
      <dl className="flex flex-col px-4 py-1.5">
        {rows
          ? rows.map((row) => (
              <div key={row.label} className="flex h-9 items-center justify-between gap-3 border-b border-line last:border-0">
                <dt className="text-sm text-fg-muted">{row.label}</dt>
                <dd>
                  {row.tone ? (
                    <StatusBadge tone={row.tone} dot>
                      {row.value}
                    </StatusBadge>
                  ) : (
                    <span className="tabular text-sm text-fg">{row.value}</span>
                  )}
                </dd>
              </div>
            ))
          : Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex h-9 items-center justify-between border-b border-line last:border-0">
                <Skeleton className="h-2.5 w-24" />
                <Skeleton className="h-2.5 w-16" />
              </div>
            ))}
      </dl>
    </Panel>
  )
}
