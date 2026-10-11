import { Link2, SquarePen } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import type { AutomationConfig } from '@shared/types/automation'
import { Button, Checkbox, Field, Input, SearchField, SegmentedControl, Switch, Textarea } from '@/components/ui'
import { useDrafts } from '@/data/drafts'
import { useLinks } from '@/data/links'
import { NAV_ITEMS } from '@/app/navigation'
import { DraftPicker } from './DraftPicker'
import { ProfileTargets } from './ProfileTargets'

export type CampaignAction = 'post' | 'repost' | 'comment'

/** The four choices of a campaign; everything else is fixed (see toConfig). */
export interface CampaignChoices {
  name: string
  action: CampaignAction
  targets: AutomationConfig['targets']
  draftIds: string[]
  /** Post each selected post from every selected profile (repeated content) instead of spreading them. */
  everyProfile: boolean
  /** Repost / comment targets (post links). */
  repostLinks: string[]
  /** Your comment (comment action) — you approve and post it yourself from the task. */
  commentText: string
  when: 'now' | 'schedule'
  startAt: string | null
}

export const defaultChoices = (): CampaignChoices => ({
  name: 'My campaign',
  action: 'post',
  targets: { scope: 'all', profileIds: [], distribution: 'unique', allowDuplicates: false, requireConfirmedIdentity: true, createMissingAccounts: false },
  draftIds: [],
  everyProfile: false,
  repostLinks: [],
  commentText: '',
  when: 'now',
  startAt: null
})

/**
 * The automation config for these choices, on the existing campaign engine. Fixed: posted
 * automatically, signed-in account always checked, one post per slot (queue spacing applies),
 * no end date / posting days / hours. Reposts and comments are tasks you complete in the profile —
 * one of your accounts per post (several of your accounts on one post is coordinated engagement);
 * the comment is your own text.
 */
export function toConfig(c: CampaignChoices): AutomationConfig {
  const posting = c.action === 'post'
  const count = Math.min(Math.max(c.draftIds.length, 1), 50)
  return {
    name: c.name.trim() || 'Campaign',
    mode: 'full-auto',
    content: {
      source: 'drafts',
      draftIds: posting ? c.draftIds : [],
      prompt: '',
      topic: '',
      language: 'English',
      tone: 'professional',
      length: 'short',
      hashtags: [],
      suggestHashtags: false,
      instructions: '',
      generateText: false,
      textProviderId: null,
      textModel: null,
      fixedText: '',
      generateImages: false,
      imageProviderId: null,
      imageModel: null,
      imageStyle: 'illustration',
      imageSize: '1024x1024',
      existingAssetId: null
    },
    targets: { ...c.targets, distribution: posting && c.everyProfile ? 'same' : 'unique', allowDuplicates: posting && c.everyProfile, requireConfirmedIdentity: true, createMissingAccounts: false },
    actions: {
      publish: posting,
      saveDrafts: false,
      repost: c.action === 'repost',
      comment: c.action === 'comment',
      like: false,
      engagementLinks: posting ? [] : c.repostLinks,
      commentText: c.action === 'comment' ? c.commentText : ''
    },
    schedule: { when: c.when, startAt: c.when === 'schedule' ? c.startAt : null, endAt: null, intervalMinutes: 0, postsPerProfile: count, maxPostsPerRun: 500, workingHours: { enabled: false, start: '09:00', end: '18:00' }, days: [0, 1, 2, 3, 4, 5, 6] },
    failure: { generationRetries: 0, onTextFailure: 'skip', onImageFailure: 'skip', onProfileUnavailable: 'skip', stopAfterFailures: 3 }
  }
}

/** Choices from an older saved setup (e.g. a dashboard quick-start link): keep what still applies. */
export function choicesFrom(config: AutomationConfig): CampaignChoices {
  const base = defaultChoices()
  return {
    ...base,
    name: config.name,
    targets: { ...base.targets, scope: config.targets.scope, profileIds: config.targets.profileIds },
    draftIds: config.content.source === 'drafts' ? config.content.draftIds : [],
    when: config.schedule.when,
    startAt: config.schedule.startAt
  }
}

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

/** Campaign: action → profiles → posts → run time. */
export function CampaignForm({ value, onChange }: { value: CampaignChoices; onChange: (next: CampaignChoices) => void }) {
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
            {value.action === 'repost' ? 'Reposts' : 'Comments'} are tasks you complete in the profile — X Auto opens the post for you but doesn’t {value.action === 'repost' ? 'repost' : 'comment'} by itself. One of your accounts per post, never the same action from several of your accounts.
          </p>
        )}
      </Section>

      <Section step={2} title="Profiles">
        <ProfileTargets value={value.targets} onChange={(targets) => set({ targets })} publishing simple />
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
              <label className="flex items-center justify-between gap-3 text-sm">
                <span className="flex flex-col">
                  <span className="text-fg">Post each one from every selected profile</span>
                  <span className="text-xs text-fg-subtle">Off: the posts are shared out, one profile each. On: the same text from several accounts, which X can limit.</span>
                </span>
                <Switch checked={value.everyProfile} onChange={(everyProfile) => set({ everyProfile })} aria-label="Post each one from every selected profile" />
              </label>
            </>
          )
        ) : (
          <>
            <LinkPicker value={value.repostLinks} onChange={(repostLinks) => set({ repostLinks })} />
            {value.action === 'comment' && (
              <Field label="Your comment" htmlFor="camp-comment" hint="Relevant to the post and written by you; copied into each task — you post it yourself.">
                <Textarea id="camp-comment" rows={3} maxLength={280} value={value.commentText} onChange={(e) => set({ commentText: e.target.value })} />
              </Field>
            )}
          </>
        )}
      </Section>

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
        <p className="text-xs text-fg-subtle">Posts go out while X Auto is running, one at a time per profile.</p>
      </Section>
    </div>
  )
}

/** Posts from the Post Links library to repost. */
function LinkPicker({ value, onChange }: { value: string[]; onChange: (urls: string[]) => void }) {
  const navigate = useNavigate()
  const links = useLinks()
  const [query, setQuery] = useState('')
  const list = (links.data ?? []).filter((l) => l.postId)
  const shown = list.filter((l) => !query.trim() || `${l.url} ${l.preview} ${l.handle ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
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
