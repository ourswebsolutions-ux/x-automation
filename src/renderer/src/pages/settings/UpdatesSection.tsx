import { Download, ExternalLink, RefreshCw, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types/updates'
import { Button, SettingsRow, SettingsSection, StatusBadge, useToast, type Tone } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'
import { formatDateTime, formatRelative } from '@/lib/format'

const STATE: Record<UpdateStatus['state'], { label: string; tone: Tone }> = {
  idle: { label: 'Not checked yet', tone: 'neutral' },
  checking: { label: 'Checking…', tone: 'info' },
  'up-to-date': { label: 'Up to date', tone: 'success' },
  available: { label: 'Update available', tone: 'info' },
  downloading: { label: 'Downloading', tone: 'info' },
  downloaded: { label: 'Ready to install', tone: 'success' },
  installing: { label: 'Restarting…', tone: 'info' },
  error: { label: 'Problem', tone: 'warning' }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Settings → Security & app info → Updates: check, download (with progress) and restart to install. */
export function UpdatesSection() {
  const toast = useToast()
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void relay.updates.status().then((s) => live && setStatus(s))
    const off = relay.updates.onChange((s) => live && setStatus(s))
    return () => {
      live = false
      off()
    }
  }, [])

  const act = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name)
    try {
      await action()
    } catch (error) {
      toast({ tone: 'warning', title: 'Update', description: errorMessage(error), duration: 9000 })
    } finally {
      setBusy(null)
      setStatus(await relay.updates.status())
    }
  }

  if (!status) return null
  const meta = STATE[status.state]
  const available = status.available
  const inApp = status.mode === 'in-app'

  return (
    <SettingsSection title="Updates" description={status.channel === 'prerelease' ? 'Pre-release channel: this build also receives pre-release versions.' : 'New versions are published on the project’s GitHub Releases page.'}>
      <SettingsRow
        label={`X Auto ${status.currentVersion}`}
        description={
          status.mode === 'disabled'
            ? (status.modeReason ?? 'Updates are turned off in this build.')
            : status.lastCheckedAt
              ? `Last checked ${formatRelative(status.lastCheckedAt)}.`
              : 'Checks automatically a little after start-up, then every few hours.'
        }
        control={
          <span className="flex items-center gap-2">
            <StatusBadge tone={meta.tone} dot pulse={status.state === 'checking' || status.state === 'downloading'}>
              {meta.label}
            </StatusBadge>
            {status.mode !== 'disabled' && (
              <Button size="sm" icon={RefreshCw} loading={busy === 'check' || status.state === 'checking'} disabled={['downloading', 'downloaded', 'installing'].includes(status.state)} onClick={() => act('check', () => relay.updates.check())}>
                Check for updates
              </Button>
            )}
          </span>
        }
      />
      {status.mode === 'manual' && status.modeReason && <p className="px-4 pb-3 text-xs text-fg-subtle">{status.modeReason}</p>}
      {status.error && <p className="px-4 pb-3 text-xs text-warning">{status.error}</p>}

      {available && (
        <div className="flex flex-col gap-3 border-t border-line px-4 py-4" aria-label="Available update">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-sm font-medium text-fg">Version {available.version}</span>
            {available.releaseDate && <span className="text-xs text-fg-subtle">Released {formatDateTime(available.releaseDate)}</span>}
            <span className="ml-auto flex flex-wrap gap-2">
              {inApp && status.state === 'available' && (
                <Button size="sm" variant="primary" icon={Download} loading={busy === 'download'} onClick={() => act('download', () => relay.updates.download())}>
                  Download update
                </Button>
              )}
              {inApp && (status.state === 'downloaded' || status.state === 'installing') && (
                <Button size="sm" variant="primary" icon={RotateCcw} loading={busy === 'install' || status.state === 'installing'} onClick={() => act('install', () => relay.updates.install())}>
                  Restart and install
                </Button>
              )}
              <Button size="sm" variant={inApp ? 'ghost' : 'primary'} icon={ExternalLink} onClick={() => act('page', () => relay.updates.openReleasePage())}>
                {inApp ? 'Release page' : 'Download from the release page'}
              </Button>
            </span>
          </div>
          {status.state === 'downloading' && status.progress && (
            <div className="flex flex-col gap-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-4" role="progressbar" aria-valuenow={status.progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Download progress">
                <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${status.progress.percent}%` }} />
              </div>
              <span className="tabular text-xs text-fg-subtle">
                {status.progress.percent.toFixed(0)}% · {mb(status.progress.transferred)} of {mb(status.progress.total)}
                {status.progress.bytesPerSecond > 0 ? ` · ${mb(status.progress.bytesPerSecond)}/s` : ''}
              </span>
            </div>
          )}
          {status.state === 'downloaded' && <p className="text-xs text-fg-subtle">Downloaded and verified. X Auto restarts to install it — your accounts, settings, drafts, schedules and data stay as they are.</p>}
          {status.installBlockedReason && <p className="text-xs text-warning">{status.installBlockedReason}</p>}
          {available.releaseNotes && <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-3 px-3 py-2 font-sans text-xs text-fg-muted">{available.releaseNotes}</pre>}
        </div>
      )}
    </SettingsSection>
  )
}
