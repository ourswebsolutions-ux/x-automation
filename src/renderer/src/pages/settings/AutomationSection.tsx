import { Activity, CircleCheck, CircleX, Cpu, RotateCw } from 'lucide-react'
import { useState } from 'react'
import type { EngineSelfCheck, EngineState } from '@shared/types/engine'
import { Button, Notice, SkeletonRows, StatusBadge, useToast, type Tone } from '@/components/ui'
import { useEngineStatus } from '@/data/engine'
import { useAsync } from '@/hooks/useAsync'
import { relay } from '@/lib/bridge'
import { formatRelative } from '@/lib/format'
import { PublishingSection } from './PublishingSection'

/** Plain-language engine states — no exit codes, paths or log output. */
const STATE: Record<EngineState, { label: string; tone: Tone; detail: string }> = {
  stopped: { label: 'Ready to start', tone: 'neutral', detail: 'Starts by itself when a task needs it.' },
  starting: { label: 'Starting', tone: 'info', detail: 'Getting ready…' },
  ready: { label: 'Running', tone: 'success', detail: 'Ready for browser tasks.' },
  stopping: { label: 'Stopping', tone: 'neutral', detail: 'Shutting down cleanly…' },
  crashed: { label: 'Restarting when needed', tone: 'warning', detail: 'It stopped unexpectedly and will start again for the next task.' },
  failed: { label: 'Stopped', tone: 'danger', detail: 'It stopped repeatedly and won’t restart by itself. Choose Restart. If this keeps happening, reinstall X Auto.' },
  unavailable: { label: 'Not installed', tone: 'danger', detail: 'Part of this installation is missing. Reinstall X Auto.' }
}

/** Settings → Automation: the engine's state in plain words, then publishing and engagement preferences. */
export function AutomationSection() {
  const toast = useToast()
  const status = useEngineStatus()
  const lastCheck = useAsync(() => relay.engine.lastSelfCheck(), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [check, setCheck] = useState<EngineSelfCheck | null>(null)
  const s = status.data
  const meta = s ? STATE[s.state] : null
  const selfCheck = check ?? lastCheck.data ?? null

  const act = async (name: string, run: () => Promise<unknown>, success?: string) => {
    setBusy(name)
    try {
      await run()
      if (success) toast({ tone: 'success', title: success })
    } catch {
      toast({ tone: 'danger', title: 'The automation engine could not start', description: 'Try Restart. If it keeps failing, reinstall X Auto.', duration: 9000 })
    } finally {
      setBusy(null)
      status.reload()
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-fg">Automation</h2>
        <p className="text-sm text-fg-subtle text-pretty">
          Publishing runs in a built-in automation engine that X Auto starts and stops by itself — there is nothing to install or run separately. It works in the
          browser IX Browser opens for each profile.
        </p>
      </div>

      {!s || !meta ? (
        <SkeletonRows rows={2} />
      ) : (
        <section aria-label="Automation engine" className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-line bg-surface-2 px-4 py-3.5">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-3 text-fg-muted">
              <Cpu size={16} />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-sm text-fg">
                Automation engine
                <StatusBadge tone={meta.tone} dot pulse={s.state === 'starting'}>
                  {meta.label}
                </StatusBadge>
              </span>
              <span className="text-xs text-fg-subtle">
                {meta.detail}
                {s.state === 'ready' && s.startedAt ? ` Running since ${formatRelative(s.startedAt)}.` : ''}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button size="sm" icon={RotateCw} loading={busy === 'restart'} disabled={s.state === 'unavailable'} onClick={() => act('restart', () => relay.engine.restart(), 'Automation engine restarted')}>
              Restart
            </Button>
            <Button size="sm" variant="secondary" icon={Activity} loading={busy === 'check'} disabled={s.state === 'unavailable'} onClick={() => act('check', async () => setCheck(await relay.engine.selfCheck()))}>
              Check it works
            </Button>
          </div>
        </section>
      )}

      {selfCheck && (
        <Notice tone={selfCheck.ok ? 'neutral' : 'warning'} icon={selfCheck.ok ? CircleCheck : CircleX} title={selfCheck.ok ? 'The automation engine works' : 'The automation engine could not start'}>
          {selfCheck.ok
            ? `Checked ${formatRelative(selfCheck.checkedAt)}. To check a specific browser profile, use “Check automation compatibility” on it in Accounts & Profiles.`
            : 'Choose Restart and check again. If it keeps failing, reinstall X Auto.'}
        </Notice>
      )}

      <PublishingSection />
    </>
  )
}
