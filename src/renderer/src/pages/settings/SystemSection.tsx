import { FileDown, Gauge, Stethoscope, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { HealthReport } from '@shared/types/storage'
import { Button, Notice, SettingsRow, SettingsSection, useToast } from '@/components/ui'
import { useAsync } from '@/hooks/useAsync'
import { errorMessage, relay } from '@/lib/bridge'
import { AboutSection } from './AboutSection'
import { SecuritySection } from './SecuritySection'

/**
 * Settings → Security & app info: how data is protected, app information, a
 * data check, and a diagnostics file for support (redacted; never shown here).
 */
export function SystemSection() {
  const toast = useToast()
  const navigate = useNavigate()
  const info = useAsync(() => relay.database.info(), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthReport | null>(null)
  const act = async (name: string, action: () => Promise<void>) => {
    setBusy(name)
    try {
      await action()
    } catch (error) {
      toast({ tone: 'danger', title: 'That didn’t work', description: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      {info.data?.recoveredFrom && (
        <Notice tone="warning" icon={TriangleAlert} title="A damaged data file was set aside at startup">
          X Auto started with a fresh data file so it could open. To get your data back, restore a recent backup.{' '}
          <Button size="sm" variant="ghost" onClick={() => navigate('/settings?section=backup')}>
            Go to Backup & restore
          </Button>
        </Notice>
      )}
      <SecuritySection />
      <SettingsSection title="Your data" description="Everything is stored on this computer.">
        <SettingsRow
          label="Check data"
          description={health ? (health.ok ? 'Everything checked out.' : 'A problem was found. Restore a recent backup, or contact support with a diagnostics file.') : 'Makes sure the app’s data file is complete and consistent.'}
          control={
            <Button size="sm" icon={Stethoscope} loading={busy === 'health'} onClick={() => act('health', async () => setHealth(await relay.database.healthCheck()))}>
              Check now
            </Button>
          }
        />
        <SettingsRow
          label="Free up space"
          description="Compacts the data file after many deletions."
          control={
            <Button size="sm" icon={Gauge} loading={busy === 'compact'} onClick={() => act('compact', async () => (await relay.database.compact(), toast({ tone: 'success', title: 'Data file compacted' })))}>
              Compact
            </Button>
          }
        />
        <SettingsRow
          label="Diagnostics file for support"
          description="Saves a file with the app’s internal activity record so support can help. Keys, passwords, cookies and tokens are removed first."
          control={
            <Button
              size="sm"
              icon={FileDown}
              loading={busy === 'diag'}
              onClick={() =>
                act('diag', async () => {
                  const r = await relay.logs.export('text')
                  if (r.status === 'saved') toast({ tone: 'success', title: 'Diagnostics file saved', description: r.fileName })
                })
              }
            >
              Save file…
            </Button>
          }
        />
      </SettingsSection>
      <AboutSection />
    </>
  )
}
