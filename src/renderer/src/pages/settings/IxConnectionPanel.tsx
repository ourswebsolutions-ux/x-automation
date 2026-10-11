import { CircleCheck, CircleX, PlugZap } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, SettingsSection, StatusBadge, useToast } from '@/components/ui'
import { useIxOverview } from '@/data/ixbrowser'
import { errorMessage, relay } from '@/lib/bridge'
import { formatDateTime } from '@/lib/format'

/** Real connection diagnostics for the active IX Browser configuration. */
export function IxConnectionPanel() {
  const overview = useIxOverview()
  const toast = useToast()
  const navigate = useNavigate()
  const [testing, setTesting] = useState(false)
  const o = overview.data
  const t = o?.lastTest ?? null

  const test = async () => {
    setTesting(true)
    try {
      const result = await relay.ixbrowser.testConnection()
      toast(
        result.ok
          ? { tone: 'success', title: 'Connected to IX Browser', description: `${result.totalProfiles} profiles · ${result.latencyMs} ms` }
          : { tone: 'danger', title: 'Connection failed', description: result.error?.message, duration: 8000 }
      )
    } catch (error) {
      toast({ tone: 'danger', title: 'Connection test failed', description: errorMessage(error) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <SettingsSection
      title="Connection"
      description="A test sends a real profile-list request to the active connection. Nothing is reported as connected until IX Browser answers."
      meta={t ? <StatusBadge tone={t.ok ? 'success' : 'danger'} dot>{t.ok ? 'Connected' : 'Failed'}</StatusBadge> : undefined}
    >
      <div className="flex flex-wrap items-center gap-4 px-4 py-3.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm text-fg">{o?.configured ? (o.providerName ?? 'IX Browser') : 'No active connection'}</span>
          <span className="text-xs text-fg-subtle">
            {o?.configured ? 'The first enabled, complete configuration below is used.' : 'Add a connection below and keep it enabled.'}
          </span>
        </div>
        <Button icon={PlugZap} loading={testing} disabled={!o?.configured} onClick={test}>
          Test connection
        </Button>
        {o?.configured && (
          <Button variant="ghost" onClick={() => navigate('/accounts')}>
            View profiles
          </Button>
        )}
      </div>
      {t && (
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 px-4 py-3.5 text-sm @2xl:grid-cols-4">
          {[
            ['Result', t.ok ? 'Success' : (t.error?.kind ?? 'Failed')],
            ['Checked', formatDateTime(t.checkedAt)],
            ['Latency', t.latencyMs !== null ? `${t.latencyMs} ms` : '—'],
            ['Profiles reported', t.totalProfiles !== null ? String(t.totalProfiles) : '—']
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5">
              <dt className="text-xs text-fg-subtle">{label}</dt>
              <dd className="tabular flex items-center gap-1.5 text-fg">
                {label === 'Result' && (t.ok ? <CircleCheck size={13} className="text-success" /> : <CircleX size={13} className="text-danger" />)}
                {value}
              </dd>
            </div>
          ))}
          <div className="col-span-full flex flex-col gap-0.5">
            <dt className="text-xs text-fg-subtle">API</dt>
            <dd data-selectable className="font-mono text-xs text-fg-muted">
              POST {t.endpoint}/api/v2/profile-list · Local API {t.apiVersion.toUpperCase()}
            </dd>
          </div>
          {t.error && (
            <div className="col-span-full rounded-md border border-danger/25 bg-danger-soft px-3 py-2">
              <p className="text-sm text-danger">{t.error.message}</p>
              <p className="text-xs text-fg-muted">{t.error.hint}</p>
            </div>
          )}
        </dl>
      )}
    </SettingsSection>
  )
}
