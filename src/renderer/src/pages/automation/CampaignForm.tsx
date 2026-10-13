import { Link2, RefreshCw, SquarePen, UsersRound } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import type { RunPlan } from '@shared/types/automation'
import { Button, Checkbox, Field, Input, SearchField, SegmentedControl, Spinner, Textarea, useToast } from '@/components/ui'
import { useDrafts } from '@/data/drafts'
import { useLinks } from '@/data/links'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatDateTime } from '@/lib/format'
import { NAV_ITEMS } from '@/app/navigation'
import { DraftPicker } from './DraftPicker'

export { choicesFrom, defaultChoices, toConfig, type CampaignAction, type CampaignChoices } from '@shared/lib/campaign'
import type { CampaignAction, CampaignChoices } from '@shared/lib/campaign'

const pad = (n: number) => String(n).padStart(2, '0')
const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function Section({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 px-5 py-4">
      <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
        <span className="tabular text-xs text-accent-text">{step}</span>
        {title}
      </h2>
      {children}
    </section>
  )
}

/** Who takes part: every eligible synchronized profile (counted by the main process), with a way to sync. */
function Participants({ plan, checking }: { plan: RunPlan | null; checking: boolean }) {
  const toast = useToast()
  const navigate = useNavigate()
  const [syncing, setSyncing] = useState(false)
  const sync = async () => {
    setSyncing(true)
    try {
      const run = await relay.ixbrowser.sync()
      toast({ tone: run.linkFailed ? 'warning' : 'success', title: 'Profiles synchronized', description: `${run.discovered} found · ${run.linked} newly linked${run.linkFailed ? ` · ${run.linkFailed} could not be linked` : ''}` })
    } catch (error) {
      toast({ tone: 'danger', title: 'Sync failed', description: errorMessage(error), duration: 9000 })
    } finally {
      setSyncing(false)
    }
  }
  const p = plan?.profiles
  return (
    <div className="flex flex-wrap items-center gap-3">
      <UsersRound size={15} className="text-fg-subtle" />
      <span className="text-sm text-fg" aria-live="polite">
        {!p ? (
          checking ? <Spinner size={12} /> : 'Checking your profiles…'
        ) : p.selected === 0 ? (
          'No profiles are synchronized yet. Sync profiles first.'
        ) : (
          <>
            <strong className="tabular font-semibold">{p.eligible}</strong> of {p.selected} synchronized {p.selected === 1 ? 'profile takes' : 'profiles take'} part
            {p.unavailable ? <span className="text-fg-subtle"> · {p.unavailable} unavailable</span> : null}
            {p.selected - p.unavailable - p.eligible > 0 ? <span className="text-fg-subtle"> · {p.selected - p.unavailable - p.eligible} disabled for tasks</span> : null}
          </>
        )}
      </span>
      <span className="ml-auto flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => navigate('/accounts?view=profiles')}>
          View profiles
        </Button>
        <Button size="sm" variant={p?.selected === 0 ? 'primary' : 'ghost'} icon={RefreshCw} loading={syncing} onClick={sync}>
          Sync profiles
        </Button>
      </span>
    </div>
  )
}

/** Campaign: action → posts → run time. Profiles aren't chosen: every eligible synchronized profile takes part. */
export function CampaignForm({ value, onChange, plan, checking }: { value: CampaignChoices; onChange: (next: CampaignChoices) => void; plan: RunPlan | null; checking: boolean }) {
  const navigate = useNavigate()
  const drafts = useDrafts()
  const set = (patch: Partial<CampaignChoices>) => onChange({ ...value, ...patch })
  const usable = (drafts.data ?? []).filter((d) => d.status === 'draft' || d.status === 'ready')

  return (
    <div className="flex flex-col gap-4">
      <Field label="Campaign name" htmlFor="camp-name">
        <Input id="camp-name" value={value.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
      </Field>

      <Section step={1} title="Action">
        <SegmentedControl<CampaignAction>
          aria-label="Action type"
          value={value.action}
          onChange={(action) => set({ action })}
          options={[
            { value: 'post', label: 'Post' },
            { value: 'repost', label: 'Repost' },
            { value: 'comment', label: 'Comment' }
          ]}
          className="self-start"
        />
        {value.action !== 'post' && (
          <p className="text-xs text-fg-subtle">
            {value.action === 'repost'
              ? 'X Auto reposts each chosen post at the run time from one of your accounts, in its own profile, and counts it only once the post shows as reposted on X.'
              : 'X Auto posts your comment as a reply to the chosen post at the run time, from one of your accounts, and counts it only once X confirms it.'}{' '}
            One of your accounts per post — never the same action from several of your accounts (that is coordinated engagement).{value.action === 'comment' ? ' One post per comment.' : ''}
          </p>
        )}
      </Section>

      <Section step={2} title="Profiles">
        <Participants plan={plan} checking={checking} />
      </Section>

      <Section step={3} title={value.action === 'post' ? 'Posts' : value.action === 'repost' ? 'Posts to repost' : 'Posts to comment on'}>
        {value.action === 'post' ? (
          drafts.data && usable.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-line-strong px-4 py-5">
              <p className="text-sm text-fg-muted">You have no saved posts yet.</p>
              <Button variant="primary" icon={SquarePen} onClick={() => navigate(NAV_ITEMS.create.path)}>
                Create a post
              </Button>
            </div>
          ) : (
            <>
              {drafts.data && <p className="text-xs text-fg-subtle">{usable.length} saved {usable.length === 1 ? 'post' : 'posts'} available · add more in Create Post</p>}
              <DraftPicker value={value.draftIds} onChange={(draftIds) => set({ draftIds })} />
              {plan && plan.comments > 0 && (
                <p className="text-xs text-fg-subtle">
                  {plan.comments === 1 ? 'One post has a comment' : `${plan.comments} posts have a comment`}: each is posted as a reply by the same account, right after X confirms its post.
                </p>
              )}
              <p className="text-xs text-fg-subtle" aria-live="polite">
                {plan && plan.fromDrafts > 0
                  ? `Each selected post goes out once, from one randomly chosen profile: ${plan.posts} ${plan.posts === 1 ? 'post' : 'posts'} on ${new Set(plan.postPreview.map((p) => p.accountId)).size} ${new Set(plan.postPreview.map((p) => p.accountId)).size === 1 ? 'profile' : 'profiles'} (a different profile for each post while there are enough).`
                  : 'Each selected post goes out once, from one randomly chosen synchronized profile.'}{' '}
                The assignment is shown in the preview; posts from one account are spaced out (Settings → Automation).
              </p>
            </>
          )
        ) : (
          <>
            <LinkPicker value={value.repostLinks} onChange={(repostLinks) => set({ repostLinks })} />
            {value.action === 'comment' && (
              <Field label="Your comment" htmlFor="camp-comment" hint="Written by you and relevant to the post; posted as a reply to it at the run time. (To comment on your own new posts, add the comment in Create Post.)">
                <Textarea id="camp-comment" rows={3} maxLength={280} value={value.commentText} onChange={(e) => set({ commentText: e.target.value })} />
              </Field>
            )}
          </>
        )}
      </Section>

      <AssignmentPreview plan={plan} checking={checking} action={value.action} when={value.when} />

      <Section step={4} title="Run time">
        <SegmentedControl<'now' | 'schedule'>
          aria-label="Run time"
          value={value.when}
          onChange={(when) => set({ when, startAt: when === 'schedule' ? (value.startAt ?? new Date(Date.now() + 3_600_000).toISOString()) : null })}
          options={[
            { value: 'now', label: 'Now' },
            { value: 'schedule', label: 'At a date and time' }
          ]}
          className="self-start"
        />
        {value.when === 'schedule' && (
          <Input
            id="camp-start"
            aria-label="Run at"
            type="datetime-local"
            value={toLocalInput(value.startAt)}
            onChange={(e) => set({ startAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
            wrapperClassName="w-60"
          />
        )}
        <p className="text-xs text-fg-subtle">Any future date and time, in this computer’s time zone. Posts go out while X Auto is running (the window can be closed), one at a time per profile.</p>
      </Section>
    </div>
  )
}

/**
 * Before Start: each selected post, the one randomly chosen account it is assigned to, when it runs,
 * and every skipped post with its reason. Start makes exactly this assignment (same random order).
 */
function AssignmentPreview({ plan, checking, action, when }: { plan: RunPlan | null; checking: boolean; action: CampaignAction; when: 'now' | 'schedule' }) {
  const rows =
    action === 'post'
      ? (plan?.postPreview ?? []).map((p, i) => ({ key: `${p.draftId}|${i}`, title: p.text.trim().replace(/\s+/g, ' ') || 'Image-only post', mono: false, accountLabel: p.accountLabel, runAt: when === 'now' ? null : p.runAt, skipped: null as string | null }))
      : (plan?.engagementPreview ?? []).map((r) => ({ key: `${r.url}|${r.kind}`, title: r.url.replace('https://x.com/', ''), mono: true, accountLabel: r.accountLabel, runAt: r.runAt, skipped: r.skipped }))
  const assigned = rows.filter((r) => !r.skipped).length
  const noun = action === 'post' ? ['post', 'posts'] : action === 'repost' ? ['repost', 'reposts'] : ['comment', 'comments']
  return (
    <section aria-label="Preview" className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2 px-5 py-4">
      <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
        Preview
        {checking && <Spinner size={12} />}
        <span className="ml-auto text-xs font-normal text-fg-subtle" aria-live="polite">
          {rows.length ? `${assigned} ${assigned === 1 ? noun[0] : noun[1]}${rows.length - assigned ? ` · ${rows.length - assigned} skipped` : ''}` : 'Choose posts to see the plan'}
        </span>
      </h2>
      <p className="text-xs text-fg-subtle">Each post goes to one randomly chosen account (a different one for each post while there are enough) — never several of your accounts on the same post.</p>
      {rows.length > 0 && (
        <ul className="flex max-h-72 flex-col divide-y divide-line overflow-y-auto rounded-md border border-line" aria-label="Planned tasks">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
              <span className={cn('min-w-0 flex-1 truncate text-fg-muted', r.mono ? 'font-mono text-xs' : 'text-sm')} title={r.title}>
                {r.title}
              </span>
              {r.skipped ? (
                <span className="text-xs text-warning">{r.skipped}</span>
              ) : (
                <>
                  <span className="text-xs text-fg">{r.accountLabel ?? 'Account'}</span>
                  <span className="tabular text-xs text-fg-subtle">{r.runAt ? formatDateTime(r.runAt) : 'Now'}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Posts from the Post Links library to repost. */
function LinkPicker({ value, onChange }: { value: string[]; onChange: (urls: string[]) => void }) {
  const navigate = useNavigate()
  const links = useLinks()
  const [query, setQuery] = useState('')
  const list = (links.data ?? []).filter((l) => l.postId)
  const shown = list.filter((l) => !query.trim() || `${l.url} ${l.preview} ${l.handle ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  // Select All covers the posts shown (all of them, or those matching the search).
  const shownSelected = shown.filter((l) => value.includes(l.url)).length
  const allShown = shown.length > 0 && shownSelected === shown.length
  const toggleAll = (on: boolean) =>
    onChange(on ? [...new Set([...value, ...shown.map((l) => l.url)])] : value.filter((u) => !shown.some((l) => l.url === u)))
  if (links.data && list.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-line-strong px-4 py-5">
        <p className="text-sm text-fg-muted">No post links yet. Add the posts you want to act on in Post Links.</p>
        <Button icon={Link2} onClick={() => navigate(NAV_ITEMS.links.path)}>
          Open Post Links
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line">
      <p className="px-3 pt-2 text-xs text-fg-subtle">{list.length} post {list.length === 1 ? 'link' : 'links'} available · add more in Post Links</p>
      <div className="border-b border-line px-3 py-2">
        <SearchField value={query} onChange={setQuery} placeholder="Search post links" size="sm" />
      </div>
      <label className="flex items-center gap-3 border-b border-line px-3 py-2 text-sm text-fg">
        <Checkbox checked={allShown} indeterminate={shownSelected > 0 && !allShown} onChange={toggleAll} aria-label="Select all posts" disabled={shown.length === 0} />
        <span className="flex-1">Select all{query.trim() ? ' matching' : ''}</span>
        <span className="tabular text-xs text-fg-subtle">
          {shownSelected} of {shown.length}
        </span>
      </label>
      <ul className="max-h-64 overflow-y-auto" aria-label="Post links">
        {shown.map((l) => (
          <li key={l.id} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-3">
            <Checkbox checked={value.includes(l.url)} onChange={(on) => onChange(on ? [...new Set([...value, l.url])] : value.filter((u) => u !== l.url))} aria-label={`Choose ${l.url}`} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-fg">{l.preview || l.url}</span>
              <span className="truncate text-xs text-fg-subtle">{l.handle ? `@${l.handle} · ` : ''}{l.url}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="px-3 pb-2 text-xs text-fg-subtle">{value.length} selected</p>
    </div>
  )
}
