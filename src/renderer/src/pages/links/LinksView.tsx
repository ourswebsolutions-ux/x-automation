import { Check, Copy, ExternalLink, FileText, Link2, ListPlus, Plus, Tag, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Account } from '@shared/types/accounts'
import type { PostLinkView } from '@shared/types/links'
import { Button, ConfirmDialog, DataTable, EmptyState, Field, IconButton, Modal, Panel, SearchField, Select, StatusBadge, Textarea, useToast, type Column } from '@/components/ui'
import { TagInput } from '@/components/feature/TagInput'
import { useEngagement } from '@/data/links'
import { errorMessage, relay } from '@/lib/bridge'
import { formatDateTime, formatRelative, pluralize } from '@/lib/format'
import { EngagementDialog } from './EngagementDialog'
import { ENGAGEMENT_KIND } from './engagementMeta'

const SOURCE: Record<PostLinkView['source'], string> = { published: 'Published here', manual: 'Added', imported: 'Imported' }

interface LinksViewProps {
  links: PostLinkView[]
  loading: boolean
  accounts: Account[]
  knownTags: string[]
  onAdd: () => void
}

export function LinksView({ links, loading, accounts, knownTags, onAdd }: LinksViewProps) {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [account, setAccount] = useState('all')
  const [source, setSource] = useState('all')
  const [tag, setTag] = useState('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [planFor, setPlanFor] = useState<string[] | null>(null)
  const [tagging, setTagging] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return links.filter(
      (l) =>
        (account === 'all' || (account === 'none' ? !l.accountId : l.accountId === account)) &&
        (source === 'all' || l.source === source) &&
        (tag === 'all' || l.tags.includes(tag)) &&
        (!q || `${l.preview} ${l.url} ${l.handle ?? ''} ${l.accountLabel ?? ''} ${l.notes} ${l.tags.join(' ')}`.toLowerCase().includes(q))
    )
  }, [links, query, account, source, tag])
  const active = links.find((l) => l.id === activeId) ?? null
  const selectedIds = [...selected].filter((id) => links.some((l) => l.id === id))

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast({ tone: 'success', title: 'Link copied' })
    } catch {
      toast({ tone: 'danger', title: 'Could not copy the link' })
    }
  }

  const columns: Column<PostLinkView>[] = [
    {
      id: 'post',
      header: 'Post',
      width: '38%',
      sortValue: (l) => l.preview || l.url,
      cell: (l) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-fg">{l.preview || (l.handle ? `Post by @${l.handle}` : 'Post on X')}</span>
          <span className="truncate font-mono text-2xs text-fg-faint">{l.url.replace('https://', '')}</span>
        </span>
      )
    },
    {
      id: 'account',
      header: 'Account',
      width: '17%',
      sortValue: (l) => l.accountLabel ?? '',
      cell: (l) => <span className="truncate text-sm text-fg-muted">{l.accountLabel ?? <span className="text-fg-faint">—</span>}</span>
    },
    {
      id: 'tags',
      header: 'Tags',
      width: '17%',
      cell: (l) =>
        l.tags.length ? (
          <span className="flex min-w-0 gap-1 overflow-hidden">
            {l.tags.slice(0, 2).map((t) => (
              <span key={t} className="truncate rounded-sm bg-surface-4 px-1.5 py-0.5 text-2xs text-fg-muted">
                {t}
              </span>
            ))}
            {l.tags.length > 2 && <span className="text-2xs text-fg-faint">+{l.tags.length - 2}</span>}
          </span>
        ) : (
          <span className="text-fg-faint">—</span>
        )
    },
    {
      id: 'tasks',
      header: 'Tasks',
      width: '10%',
      sortValue: (l) => l.openTasks,
      cell: (l) => (l.openTasks ? <StatusBadge tone="info">{`${l.openTasks} open`}</StatusBadge> : l.doneTasks ? <span className="text-xs text-fg-subtle">{l.doneTasks} done</span> : <span className="text-fg-faint">—</span>)
    },
    {
      id: 'when',
      header: 'Date',
      align: 'right',
      sortValue: (l) => l.publishedAt ?? l.createdAt,
      cell: (l) => (
        <span className="tabular text-xs text-fg-subtle" title={l.publishedAt ? `Published ${formatDateTime(l.publishedAt)}` : `Added ${formatDateTime(l.createdAt)}`}>
          {formatRelative(l.publishedAt ?? l.createdAt)}
        </span>
      )
    }
  ]

  return (
    <div className="grid grid-cols-1 gap-4 @5xl:grid-cols-[minmax(0,1fr)_360px]">
      <Panel padded={false}>
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          <SearchField value={query} onChange={setQuery} placeholder="Search links, notes, tags" size="sm" className="min-w-48 flex-1" />
          <Select<string>
            size="sm"
            className="w-40"
            aria-label="Filter by account"
            value={account}
            onChange={setAccount}
            options={[{ value: 'all', label: 'All accounts' }, { value: 'none', label: 'No account' }, ...accounts.map((a) => ({ value: a.id, label: a.label }))]}
          />
          <Select<string>
            size="sm"
            className="w-36"
            aria-label="Filter by source"
            value={source}
            onChange={setSource}
            options={[{ value: 'all', label: 'Any source' }, ...(Object.keys(SOURCE) as PostLinkView['source'][]).map((s) => ({ value: s, label: SOURCE[s] }))]}
          />
          {knownTags.length > 0 && (
            <Select<string> size="sm" className="w-36" aria-label="Filter by tag" value={tag} onChange={setTag} options={[{ value: 'all', label: 'Any tag' }, ...knownTags.map((t) => ({ value: t, label: t }))]} />
          )}
        </div>
        {selectedIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-accent-soft/40 px-4 py-2" role="toolbar" aria-label="Selected links">
            <span className="mr-auto text-xs text-fg">{pluralize(selectedIds.length, 'link')} selected</span>
            <Button size="sm" variant="secondary" icon={ListPlus} onClick={() => setPlanFor(selectedIds)}>
              Plan a task
            </Button>
            <Button size="sm" variant="ghost" icon={Tag} onClick={() => setTagging(true)}>
              Add tags
            </Button>
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirmDelete(selectedIds)}>
              Remove
            </Button>
            <IconButton icon={X} label="Clear selection" size="sm" onClick={() => setSelected(new Set())} />
          </div>
        )}
        <div className="border-t border-line">
          <DataTable
            aria-label="Post links"
            rows={rows}
            columns={columns}
            rowKey={(l) => l.id}
            loading={loading}
            activeKey={activeId}
            onRowClick={(l) => setActiveId((c) => (c === l.id ? null : l.id))}
            selection={{ selected, onChange: setSelected, rowLabel: (l) => l.preview || l.url }}
            initialSort={{ id: 'when', direction: 'desc' }}
            empty={
              <EmptyState
                size="sm"
                icon={Link2}
                title={links.length ? 'No links match' : 'No post links yet'}
                description={links.length ? 'Try a different search or filter.' : 'Published posts are saved here automatically. You can also paste or import links.'}
                actions={
                  !links.length ? (
                    <Button size="sm" icon={Plus} onClick={onAdd}>
                      Add links
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        </div>
      </Panel>

      <LinkDetails link={active} accounts={accounts} knownTags={knownTags} onClose={() => setActiveId(null)} onPlan={(id) => setPlanFor([id])} onCopy={copy} onRemove={(id) => setConfirmDelete([id])} />

      <EngagementDialog open={Boolean(planFor)} linkIds={planFor ?? []} accounts={accounts} onClose={() => setPlanFor(null)} />
      <BulkTagDialog
        open={tagging}
        knownTags={knownTags}
        onClose={() => setTagging(false)}
        onSave={async (tags) => {
          try {
            const r = await relay.links.addTags(selectedIds, tags)
            toast({ tone: 'success', title: `Tags added to ${pluralize(r.changed, 'link')}` })
            setTagging(false)
          } catch (error) {
            toast({ tone: 'danger', title: 'Tags not added', description: errorMessage(error) })
          }
        }}
      />
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title={confirmDelete && confirmDelete.length > 1 ? `Remove ${confirmDelete.length} links?` : 'Remove this link?'}
        description="Only the record in X Auto is removed, with its engagement tasks. The post on X is not affected."
        confirmLabel="Remove"
        tone="danger"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          const ids = confirmDelete ?? []
          setConfirmDelete(null)
          try {
            const r = await relay.links.remove(ids)
            toast({ tone: 'success', title: `${pluralize(r.changed, 'link')} removed` })
            setSelected(new Set())
            if (activeId && ids.includes(activeId)) setActiveId(null)
          } catch (error) {
            toast({ tone: 'danger', title: 'Not removed', description: errorMessage(error) })
          }
        }}
      />
    </div>
  )
}

interface LinkDetailsProps {
  link: PostLinkView | null
  accounts: Account[]
  knownTags: string[]
  onClose: () => void
  onPlan: (id: string) => void
  onCopy: (url: string) => void
  onRemove: (id: string) => void
}

function LinkDetails({ link, accounts, knownTags, onClose, onPlan, onCopy, onRemove }: LinkDetailsProps) {
  const toast = useToast()
  const navigate = useNavigate()
  const tasks = useEngagement({ status: 'all', linkId: link?.id })
  const [accountId, setAccountId] = useState<string | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setAccountId(link?.accountId ?? null)
    setTags(link?.tags ?? [])
    setNotes(link?.notes ?? '')
  }, [link?.id, link?.updatedAt])

  if (!link) {
    return (
      <Panel title="Details">
        <p className="text-sm text-fg-subtle">Select a link to see its notes, tags and engagement tasks.</p>
      </Panel>
    )
  }
  const dirty = accountId !== link.accountId || notes !== link.notes || tags.join('\u0000') !== link.tags.join('\u0000')
  const save = async () => {
    setSaving(true)
    try {
      await relay.links.update(link.id, { accountId, tags, notes })
      toast({ tone: 'success', title: 'Link updated' })
    } catch (error) {
      toast({ tone: 'danger', title: 'Not saved', description: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }
  const list = tasks.data ?? []
  return (
    <Panel
      title={<span className="truncate">{link.handle ? `@${link.handle}` : 'Post'}</span>}
      meta={<StatusBadge tone={link.source === 'published' ? 'success' : 'neutral'}>{SOURCE[link.source]}</StatusBadge>}
      actions={<IconButton icon={X} label="Close details" size="sm" onClick={onClose} />}
      padded={false}
    >
      <div className="flex flex-col gap-4 px-4 py-3">
        {link.preview && <p className="text-sm text-fg">{link.preview}</p>}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" icon={ExternalLink} onClick={() => void relay.shell.openExternal(link.url)}>
            Open on X
          </Button>
          <Button size="sm" variant="ghost" icon={Copy} onClick={() => onCopy(link.url)}>
            Copy link
          </Button>
          {link.draftId && (
            <Button size="sm" variant="ghost" icon={FileText} onClick={() => navigate(`/posts?draft=${link.draftId}`)}>
              Draft
            </Button>
          )}
        </div>
        <Field label="Account" htmlFor="link-account">
          <Select<string>
            id="link-account"
            size="sm"
            value={accountId ?? 'none'}
            onChange={(v) => setAccountId(v === 'none' ? null : v)}
            options={[{ value: 'none', label: 'No account' }, ...accounts.map((a) => ({ value: a.id, label: a.label, description: a.handle ? `@${a.handle}` : undefined }))]}
          />
        </Field>
        <Field label="Tags" htmlFor="link-tags">
          <TagInput id="link-tags" value={tags} onChange={setTags} suggestions={knownTags} />
        </Field>
        <Field label="Notes" htmlFor="link-notes">
          <Textarea id="link-notes" rows={2} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="primary" icon={Check} disabled={!dirty} loading={saving} onClick={save}>
            Save
          </Button>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => onRemove(link.id)}>
            Remove
          </Button>
        </div>
        <section aria-label="Engagement tasks" className="flex flex-col gap-2 border-t border-line pt-3">
          <div className="flex items-center justify-between">
            <h3 className="text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">Engagement tasks</h3>
            <Button size="sm" variant="ghost" icon={ListPlus} onClick={() => onPlan(link.id)}>
              Plan a task
            </Button>
          </div>
          {list.length === 0 ? (
            <p className="text-xs text-fg-subtle">Nothing planned for this post.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {list.map((t) => {
                const Icon = ENGAGEMENT_KIND[t.kind].icon
                return (
                  <li key={t.id} className="flex items-center gap-2 text-xs">
                    <Icon size={13} className="shrink-0 text-fg-subtle" />
                    <span className="min-w-0 flex-1 truncate text-fg-muted">
                      {ENGAGEMENT_KIND[t.kind].label}
                      {t.accountLabel ? ` · ${t.accountLabel}` : ''}
                      {t.dueAt ? ` · ${formatDateTime(t.dueAt)}` : ''}
                    </span>
                    <StatusBadge tone={t.status === 'done' ? 'success' : t.status === 'skipped' ? 'neutral' : 'info'}>{t.status === 'open' ? 'Open' : t.status === 'done' ? 'Done' : 'Skipped'}</StatusBadge>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </Panel>
  )
}

function BulkTagDialog({ open, knownTags, onClose, onSave }: { open: boolean; knownTags: string[]; onClose: () => void; onSave: (tags: string[]) => Promise<void> }) {
  const [tags, setTags] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) setTags([])
  }, [open])
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Add tags"
      description="Added to every selected link. Existing tags are kept."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!tags.length}
            loading={saving}
            onClick={async () => {
              setSaving(true)
              await onSave(tags)
              setSaving(false)
            }}
          >
            Add tags
          </Button>
        </>
      }
    >
      <TagInput value={tags} onChange={setTags} suggestions={knownTags} />
    </Modal>
  )
}
