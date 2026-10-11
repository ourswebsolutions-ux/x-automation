import { SquarePen } from 'lucide-react'
import { type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import type { AutomationConfig } from '@shared/types/automation'
import { Button, Field, Input, SegmentedControl, Select, Switch, Textarea } from '@/components/ui'
import { useDrafts } from '@/data/drafts'
import { NAV_ITEMS } from '@/app/navigation'
import { DraftPicker } from './DraftPicker'
import { ProfileTargets } from './ProfileTargets'

interface Props {
  config: AutomationConfig
  onChange: (next: AutomationConfig) => void
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEK = [1, 2, 3, 4, 5, 6, 0]
const pad = (n: number) => String(n).padStart(2, '0')
const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null)
const num = (value: string, min: number, max: number, fallback: number) => {
  const n = Number(value)
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback
}

function Section({ step, title, description, children }: { step: number; title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-4 rounded-lg border border-line bg-surface-2 px-5 py-4">
      <header className="flex flex-col gap-0.5">
        <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
          <span className="tabular text-xs text-accent-text">{String(step).padStart(2, '0')}</span>
          {title}
        </h2>
        {description && <p className="text-xs text-fg-subtle">{description}</p>}
      </header>
      {children}
    </section>
  )
}

function Toggle({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="flex flex-col">
        <span className="text-sm text-fg">{label}</span>
        {description && <span className="text-xs text-fg-subtle">{description}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} aria-label={label} />
    </label>
  )
}

/**
 * A campaign: saved posts (AI or manual, from Create Post) → accounts → schedule → how posts go
 * out. It drives the existing automation runs (one source of truth for posts, accounts and timing).
 */
export function CampaignForm({ config, onChange }: Props) {
  const navigate = useNavigate()
  const drafts = useDrafts()
  const { content, targets, actions, schedule, failure } = config
  const set = (patch: Partial<AutomationConfig>) => onChange({ ...config, ...patch })
  const setSchedule = (patch: Partial<AutomationConfig['schedule']>) => set({ schedule: { ...schedule, ...patch } })
  const setActions = (patch: Partial<AutomationConfig['actions']>) => set({ actions: { ...actions, ...patch } })
  const usable = (drafts.data ?? []).filter((d) => d.status === 'draft' || d.status === 'ready')
  const endMode = schedule.endAt ? 'date' : 'none'
  const days = schedule.days ?? [0, 1, 2, 3, 4, 5, 6]

  return (
    <div className="flex flex-col gap-4">
      <Section step={1} title="Posts" description="Choose saved posts — written by hand or with AI in Create Post. Each is posted as it is.">
        {drafts.data && usable.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-line-strong px-4 py-5">
            <p className="text-sm text-fg-muted">You have no saved posts to use yet.</p>
            <Button variant="primary" icon={SquarePen} onClick={() => navigate(NAV_ITEMS.create.path)}>
              Create a post
            </Button>
          </div>
        ) : (
          <>
            <DraftPicker value={content.draftIds} onChange={(draftIds) => set({ content: { ...content, source: 'drafts', draftIds } })} />
            <Button size="sm" variant="ghost" icon={SquarePen} className="self-start" onClick={() => navigate(NAV_ITEMS.create.path)}>
              Create another post
            </Button>
          </>
        )}
      </Section>

      <Section step={2} title="Accounts" description="All accounts, or only the X profiles you choose.">
        <ProfileTargets value={targets} onChange={(t) => set({ targets: t })} publishing allowDraftsOnly={false} />
      </Section>

      <Section step={3} title="Schedule" description="When posts go out. Posts only go out while X Auto is running.">
        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
          <Field label="Start" htmlFor="camp-when">
            <SegmentedControl<AutomationConfig['schedule']['when']>
              value={schedule.when}
              onChange={(when) => setSchedule({ when, startAt: when === 'schedule' ? (schedule.startAt ?? new Date(Date.now() + 3_600_000).toISOString()) : null })}
              options={[
                { value: 'now', label: 'Now' },
                { value: 'schedule', label: 'At a date and time' }
              ]}
            />
          </Field>
          {schedule.when === 'schedule' && (
            <Field label="Start date and time" htmlFor="camp-start">
              <Input id="camp-start" type="datetime-local" value={toLocalInput(schedule.startAt)} onChange={(e) => setSchedule({ startAt: fromLocalInput(e.target.value) })} />
            </Field>
          )}
          <Field label="End" htmlFor="camp-end-mode">
            <Select<'none' | 'date' | 'days'>
              id="camp-end-mode"
              value={endMode}
              onChange={(mode) => {
                if (mode === 'none') setSchedule({ endAt: null })
                else {
                  const start = schedule.when === 'schedule' && schedule.startAt ? new Date(schedule.startAt) : new Date()
                  const days = mode === 'days' ? 7 : 1
                  setSchedule({ endAt: new Date(start.getTime() + days * 86_400_000).toISOString() })
                }
              }}
              options={[
                { value: 'none', label: 'No end (until all posts are out)' },
                { value: 'date', label: 'End at a date and time' },
                { value: 'days', label: 'Run for a number of days' }
              ]}
            />
          </Field>
          {schedule.endAt && (
            <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-2">
              <Field label="End date and time" htmlFor="camp-end">
                <Input id="camp-end" type="datetime-local" value={toLocalInput(schedule.endAt)} onChange={(e) => setSchedule({ endAt: fromLocalInput(e.target.value) })} />
              </Field>
              <Field label="Duration (days)" htmlFor="camp-duration">
                <Input
                  id="camp-duration"
                  inputMode="numeric"
                  value={String(Math.max(1, Math.round((new Date(schedule.endAt).getTime() - (schedule.when === 'schedule' && schedule.startAt ? new Date(schedule.startAt).getTime() : Date.now())) / 86_400_000)))}
                  onChange={(e) => {
                    const daysCount = num(e.target.value, 1, 365, 7)
                    const start = schedule.when === 'schedule' && schedule.startAt ? new Date(schedule.startAt) : new Date()
                    setSchedule({ endAt: new Date(start.getTime() + daysCount * 86_400_000).toISOString() })
                  }}
                />
              </Field>
            </div>
          )}
        </div>

        <Field label="Posting days" htmlFor="camp-days">
          <div id="camp-days" role="group" aria-label="Posting days" className="flex flex-wrap gap-1.5">
            {WEEK.map((d) => {
              const on = days.includes(d)
              return (
                <Button key={d} size="sm" variant={on ? 'primary' : 'secondary'} aria-pressed={on} onClick={() => setSchedule({ days: on ? days.filter((x) => x !== d) : [...days, d].sort() })}>
                  {DAY_NAMES[d]}
                </Button>
              )
            })}
          </div>
        </Field>

        <div className="flex flex-col gap-3">
          <Toggle
            label="Only post between set times"
            description="Daily posting hours; outside them, posts wait for the next posting day’s start."
            checked={schedule.workingHours.enabled}
            onChange={(enabled) => setSchedule({ workingHours: { ...schedule.workingHours, enabled } })}
          />
          {schedule.workingHours.enabled && (
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Input aria-label="Posting from" type="time" value={schedule.workingHours.start} onChange={(e) => setSchedule({ workingHours: { ...schedule.workingHours, start: e.target.value } })} wrapperClassName="w-28" />
              <span>to</span>
              <Input aria-label="Posting until" type="time" value={schedule.workingHours.end} onChange={(e) => setSchedule({ workingHours: { ...schedule.workingHours, end: e.target.value } })} wrapperClassName="w-28" />
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-3">
          <Field label="Minutes between posts" htmlFor="camp-interval" hint="Per account">
            <Input id="camp-interval" inputMode="numeric" value={String(schedule.intervalMinutes)} onChange={(e) => setSchedule({ intervalMinutes: num(e.target.value, 0, 1440, schedule.intervalMinutes) })} />
          </Field>
          <Field label="Posts per account" htmlFor="camp-per-profile">
            <Input id="camp-per-profile" inputMode="numeric" value={String(schedule.postsPerProfile)} onChange={(e) => setSchedule({ postsPerProfile: num(e.target.value, 1, 50, schedule.postsPerProfile) })} />
          </Field>
          <Field label="Most posts in this campaign" htmlFor="camp-max">
            <Input id="camp-max" inputMode="numeric" value={String(schedule.maxPostsPerRun)} onChange={(e) => setSchedule({ maxPostsPerRun: num(e.target.value, 1, 500, schedule.maxPostsPerRun) })} />
          </Field>
        </div>
      </Section>

      <Section step={4} title="How posts go out">
        <SegmentedControl<AutomationConfig['mode']>
          value={config.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: 'full-auto', label: 'Automatically' },
            { value: 'manual-approval', label: 'After my approval' }
          ]}
        />
        <p className="text-xs text-fg-subtle">
          {config.mode === 'full-auto' ? 'Each post is published at its time without asking again.' : 'Each post waits in the campaign until you approve, edit or remove it.'}
        </p>
        <details className="group flex flex-col gap-3 border-t border-line pt-3">
          <summary className="cursor-pointer text-xs font-medium text-fg-muted">More options</summary>
          <div className="mt-3 flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
              <Field label="A chosen account is unavailable" htmlFor="camp-unavailable">
                <Select<AutomationConfig['failure']['onProfileUnavailable']>
                  id="camp-unavailable"
                  value={failure.onProfileUnavailable}
                  onChange={(onProfileUnavailable) => set({ failure: { ...failure, onProfileUnavailable } })}
                  options={[
                    { value: 'skip', label: 'Leave it out' },
                    { value: 'stop', label: 'Don’t start' }
                  ]}
                />
              </Field>
              <Field label="Pause after failed posts in a row" htmlFor="camp-stop" hint="0 = never">
                <Input id="camp-stop" inputMode="numeric" value={String(failure.stopAfterFailures)} onChange={(e) => set({ failure: { ...failure, stopAfterFailures: num(e.target.value, 0, 100, failure.stopAfterFailures) } })} />
              </Field>
            </div>
            <p className="text-xs text-fg-subtle">Reposts, comments and likes are planned as tasks you complete in each profile — X Auto doesn’t perform them itself.</p>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <Toggle label="Repost" checked={actions.repost} onChange={(repost) => setActions({ repost })} />
              <Toggle label="Comment" checked={actions.comment} onChange={(comment) => setActions({ comment })} />
              <Toggle label="Like" checked={actions.like} onChange={(like) => setActions({ like })} />
            </div>
            {(actions.repost || actions.comment || actions.like) && (
              <Field label="Posts to engage with" htmlFor="camp-links" hint="One link per line (x.com or twitter.com).">
                <Textarea id="camp-links" rows={3} value={actions.engagementLinks.join('\n')} spellCheck={false} className="font-mono text-xs" onChange={(e) => setActions({ engagementLinks: e.target.value.split('\n') })} />
              </Field>
            )}
            {actions.comment && (
              <Field label="Your comment" htmlFor="camp-comment" hint="Copied into the task; you post it yourself.">
                <Textarea id="camp-comment" rows={2} value={actions.commentText} maxLength={4000} onChange={(e) => setActions({ commentText: e.target.value })} />
              </Field>
            )}
          </div>
        </details>
      </Section>
    </div>
  )
}

/** Campaigns post saved posts: older setups that generated text with AI are converted on load. */
export function asCampaign(config: AutomationConfig): { config: AutomationConfig; converted: boolean } {
  const converted = config.content.source !== 'drafts'
  return {
    converted,
    config: {
      ...config,
      content: { ...config.content, source: 'drafts', draftIds: converted ? [] : config.content.draftIds, generateImages: false, existingAssetId: null },
      targets: { ...config.targets, distribution: config.targets.distribution === 'drafts' ? 'unique' : config.targets.distribution },
      actions: { ...config.actions, publish: true, saveDrafts: false },
      schedule: { ...config.schedule, days: config.schedule.days ?? [0, 1, 2, 3, 4, 5, 6] }
    }
  }
}
