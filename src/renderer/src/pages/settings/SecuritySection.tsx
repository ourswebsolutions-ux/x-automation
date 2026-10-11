import { Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button, ConfirmDialog, ErrorState, SettingsSection, Skeleton, StatusBadge, useToast } from '@/components/ui'
import { useCredentialStatus } from '@/data/providers'
import { errorMessage, relay } from '@/lib/bridge'
import { useSystem } from '@/state/system'

function Row({ label, description, value }: { label: string; description: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-fg">{label}</span>
        <span className="text-xs text-fg-subtle text-pretty">{description}</span>
      </div>
      <div className="shrink-0">{value}</div>
    </div>
  )
}

const on = (good: boolean, yes = 'On', no = 'Off') => (
  <StatusBadge tone={good ? 'success' : 'danger'} dot>
    {good ? yes : no}
  </StatusBadge>
)

export function SecuritySection() {
  const { security } = useSystem()
  const s = security.data
  const credentials = useCredentialStatus()
  const c = credentials.data
  const toast = useToast()
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)

  const clearAll = async () => {
    setClearing(true)
    try {
      const removed = await relay.credentials.clearAll()
      toast({ tone: 'success', title: 'Stored keys removed', description: `${removed} key${removed === 1 ? '' : 's'} deleted from this device.` })
      setConfirmClear(false)
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not remove keys', description: errorMessage(error) })
    } finally {
      setClearing(false)
    }
  }

  return (
    <>
      <SettingsSection title="Renderer isolation" description="How this window is separated from your system. Values are read from the running app.">
        {security.status === 'error' ? (
          <ErrorState size="sm" error={security.error} onRetry={security.reload} />
        ) : !s ? (
          Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-4">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-4 w-12" />
            </div>
          ))
        ) : (
          <>
            <Row label="Context isolation" description="The interface cannot reach Electron or Node.js internals." value={on(s.contextIsolation)} />
            <Row label="Process sandbox" description="The interface runs in a Chromium sandbox with no file system access." value={on(s.sandbox)} />
            <Row label="Node.js integration" description="Disabled — the interface talks to the app only through a validated bridge." value={on(!s.nodeIntegration, 'Off', 'On')} />
            <Row label="Web security" description="Same-origin policy and a strict Content-Security-Policy are enforced." value={on(s.webSecurity)} />
          </>
        )}
      </SettingsSection>

      <SettingsSection title="Credential storage" description="Where API keys are kept and how they are protected.">
        {credentials.status === 'error' ? (
          <ErrorState size="sm" error={credentials.error} onRetry={credentials.reload} />
        ) : (
          <>
            <Row
              label={c ? c.backend : 'Checking…'}
              description={c?.detail ?? 'Checking the operating system’s secret storage.'}
              value={
                c ? (
                  <StatusBadge tone={c.secure ? 'success' : 'warning'} dot>
                    {c.secure ? 'Protected' : 'Unavailable'}
                  </StatusBadge>
                ) : (
                  <Skeleton className="h-4 w-16" />
                )
              }
            />
            <Row
              label="Stored keys"
              description="Encrypted entries in the vault file on this device. The database holds only references."
              value={<span className="tabular text-sm text-fg">{c ? c.storedCount : '—'}</span>}
            />
            <Row
              label="Remove all stored keys"
              description="Deletes every encrypted key. Provider configurations are kept and will show as incomplete."
              value={
                <Button size="sm" variant="danger" icon={Trash2} disabled={!c?.storedCount} onClick={() => setConfirmClear(true)}>
                  Remove all…
                </Button>
              }
            />
          </>
        )}
      </SettingsSection>

      <SettingsSection title="Privacy" description="How sensitive information is handled everywhere in the app.">
        <Row
          label="Keys are write-only"
          description="Once saved, a key is shown only as its last four characters. It is never sent back to this window, logged, exported or backed up."
          value={<StatusBadge tone="success" dot>Enforced</StatusBadge>}
        />
        <Row
          label="Log redaction"
          description="Anything resembling a key, token, password or cookie is masked before a log entry is stored or exported."
          value={<StatusBadge tone="success" dot>On</StatusBadge>}
        />
        <Row
          label="Permission requests"
          description="Camera, microphone, location and notification prompts from web content are denied automatically."
          value={<StatusBadge tone="success" dot>Blocked</StatusBadge>}
        />
      </SettingsSection>

      <ConfirmDialog
        open={confirmClear}
        title="Remove all stored API keys?"
        description="Every encrypted key on this device is deleted. You will need to enter them again. This can't be undone."
        confirmLabel="Remove all keys"
        tone="danger"
        busy={clearing}
        onCancel={() => setConfirmClear(false)}
        onConfirm={clearAll}
      />
    </>
  )
}
