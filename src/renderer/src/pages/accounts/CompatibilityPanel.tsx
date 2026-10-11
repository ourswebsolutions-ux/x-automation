import { CircleCheck, CircleX, Cpu, Play, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CompatStep, CompatibilityResult } from '@shared/types/engine'
import type { BrowserProfile } from '@shared/types/ixbrowser'
import { Button, Panel, Spinner, StatusBadge, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'
import { formatDateTime } from '@/lib/format'

const STEP_LABEL: Record<CompatStep['step'], string> = {
  'ix-connection': 'IX Browser connection',
  'profile-open': 'Open profile (Local API)',
  'debugging-address': 'Debugging address',
  engine: 'Automation engine',
  connect: 'Attach over CDP',
  'open-tab': 'Use the profile’s browser context',
  navigate: 'Navigate a controlled page',
  interact: 'Type, click and verify',
  screenshot: 'Debug screenshot',
  'close-tab': 'Close the test tab',
  'profile-close': 'Close profile'
}

/**
 * Per-profile automation compatibility: proves (or disproves) that the Python
 * engine can drive this IX Browser profile. Every line is a real action's result.
 */
export function CompatibilityPanel({ profile, configured }: { profile: BrowserProfile; configured: boolean }) {
  const toast = useToast()
  const [result, setResult] = useState<CompatibilityResult | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    setResult(null)
    let live = true
    relay.automation.lastResult(profile.id).then((r) => live && setResult(r), () => undefined)
    return () => {
      live = false
    }
  }, [profile.id])

  const run = async () => {
    setRunning(true)
    try {
      const r = await relay.automation.checkProfile(profile.id)
      setResult(r)
      toast(r.ok ? { tone: 'success', title: 'Automation works with this profile' } : { tone: 'warning', title: 'Automation is not possible with this profile yet', description: r.blocker ?? undefined, duration: 9000 })
    } catch (error) {
      toast({ tone: 'danger', title: 'The check could not run', description: errorMessage(error) })
    } finally {
      setRunning(false)
    }
  }

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Cpu size={14} /> Automation compatibility
        </span>
      }
      meta={result && <StatusBadge tone={result.ok ? 'success' : 'warning'} dot>{result.ok ? 'Compatible' : 'Not compatible'}</StatusBadge>}
      padded={false}
    >
      <div className="flex flex-col gap-3 px-4 py-3">
        <p className="text-xs text-fg-subtle">
          Opens this profile through IX Browser (if it is closed), attaches the automation engine to the browser IX Browser launched, and drives a local test page
          in the profile’s own window. Nothing is posted and no website is visited. The profile is closed again if the check opened it.
        </p>
        <Button size="sm" variant={result?.ok ? 'secondary' : 'primary'} icon={Play} loading={running} disabled={!configured || profile.availability !== 'available'} onClick={run} className="self-start">
          {result ? 'Run the check again' : 'Check automation compatibility'}
        </Button>
        {!configured && <p className="text-2xs text-fg-faint">Needs an active IX Browser connection.</p>}
        {running && (
          <p className="flex items-center gap-2 text-xs text-fg-muted" aria-live="polite">
            <Spinner size={12} /> Opening the profile and attaching… this can take up to a minute.
          </p>
        )}
        {result && !running && (
          <>
            <ol aria-label="Check steps" className="flex flex-col gap-1.5">
              {result.steps.map((s, i) => (
                <li key={`${s.step}-${i}`} className="flex gap-2 text-xs">
                  {s.ok ? <CircleCheck size={13} className="mt-0.5 shrink-0 text-success" /> : <CircleX size={13} className="mt-0.5 shrink-0 text-danger" />}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-baseline justify-between gap-2 text-fg">
                      {STEP_LABEL[s.step]}
                      {s.ms !== null && <span className="tabular shrink-0 text-2xs text-fg-faint">{s.ms} ms</span>}
                    </span>
                    {!s.ok && <span className="text-danger">Didn’t complete.</span>}
                  </span>
                </li>
              ))}
            </ol>
            {result.blocker && (
              <div role="alert" className="flex gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                <span>{result.blocker}</span>
              </div>
            )}
            <p className="text-2xs text-fg-faint">
              Checked {formatDateTime(result.checkedAt)}
              {result.browserVersion ? ` · ${result.browserVersion}` : ''}
              {result.ok && result.usedExistingContext ? ' · used the profile’s existing browser context' : ''}
            </p>
          </>
        )}
      </div>
    </Panel>
  )
}
