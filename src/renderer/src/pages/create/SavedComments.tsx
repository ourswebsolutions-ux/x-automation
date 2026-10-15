import { MessageSquareText, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { CommentDraft } from '@shared/types/domain'
import { Button, Checkbox, ConfirmDialog, EmptyState, ErrorState, IconButton, Input, Panel, SearchField, SkeletonRows, StatusBadge, Textarea, useToast } from '@/components/ui'
import type { AsyncResource } from '@/hooks/useAsync'
import { errorMessage, relay } from '@/lib/bridge'
import { formatRelative } from '@/lib/format'

/** Saved comments (bulk comments): edit the text or target, select all and delete. Campaigns use them from here. */
export function SavedComments({ comments }: { comments: AsyncResource<CommentDraft[]> }) {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState<{ id: string; body: string; target: string } | null>(null)
  const list = comments.data ?? []
  const shown = list.filter((c) => !query.trim() || `${c.body} ${c.targetUrl ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  const shownChecked = shown.filter((c) => checked.has(c.id)).length
  const allShown = shown.length > 0 && shownChecked === shown.length

  const toggle = (id: string, on: boolean) =>
    setChecked((c) => {
      const next = new Set(c)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const toggleAll = (on: boolean) =>
    setChecked((c) => {
      const next = new Set(c)
      for (const x of shown) on ? next.add(x.id) : next.delete(x.id)
      return next
    })

  const removeChecked = async () => {
    setDeleting(true)
    const ids = shown.filter((c) => checked.has(c.id)).map((c) => c.id)
    let removed = 0
    let error: string | null = null
    for (const id of ids) {
      try {
        await relay.comments.remove(id)
        removed++
      } catch (e) {
        error ??= errorMessage(e)
      }
    }
    setChecked(new Set())
    setDeleting(false)
    setConfirm(false)
    comments.reload()
    toast(error ? { tone: 'warning', title: `${removed} deleted, ${ids.length - removed} kept`, description: error } : { tone: 'success', title: `${removed} ${removed === 1 ? 'comment' : 'comments'} deleted` })
  }

  const saveEdit = async () => {
    if (!editing) return
    try {
      await relay.comments.update(editing.id, { body: editing.body, targetUrl: editing.target.trim() || null })
      setEditing(null)
      comments.reload()
      toast({ tone: 'success', title: 'Comment saved' })
    } catch (e) {
      toast({ tone: 'danger', title: 'Comment not saved', description: errorMessage(e), duration: 8000 })
    }
  }

  return (
    <Panel title="Saved comments" meta={<span className="tabular text-xs text-fg-subtle">{comments.data ? list.length : ''}</span>} padded={false} bodyClassName="flex min-h-0 flex-col">
      {comments.status === 'error' ? (
        <ErrorState size="sm" title="Comments could not be loaded" error={comments.error} onRetry={comments.reload} />
      ) : !comments.data ? (
        <SkeletonRows rows={4} className="p-4" />
      ) : list.length === 0 ? (
        <EmptyState size="sm" icon={MessageSquareText} title="No saved comments yet" description="Paste a list of comments and save them all at once. Campaigns post them as replies to the posts you choose." />
      ) : (
        <>
          <div className="border-b border-line px-3 py-2">
            <SearchField value={query} onChange={setQuery} placeholder="Search comments" size="sm" aria-label="Search comments" />
          </div>
          <div className="flex items-center gap-3 border-b border-line px-3.5 py-2 text-sm">
            <Checkbox checked={allShown} indeterminate={shownChecked > 0 && !allShown} onChange={toggleAll} aria-label="Select all comments" />
            <span className="flex-1 text-fg-muted">{shownChecked ? `${shownChecked} of ${shown.length} selected` : `Select all (${shown.length})`}</span>
            {shownChecked > 0 && (
              <Button size="sm" variant="danger" icon={Trash2} onClick={() => setConfirm(true)}>
                Delete {shownChecked}
              </Button>
            )}
          </div>
          <ul aria-label="Saved comments" className="max-h-[36rem] min-h-0 flex-1 divide-y divide-line overflow-y-auto">
            {shown.map((c) => (
              <li key={c.id} className="flex items-start gap-3 px-3.5 py-2.5">
                <Checkbox checked={checked.has(c.id)} onChange={(on) => toggle(c.id, on)} aria-label={`Select comment: ${c.body.slice(0, 80)}`} />
                {editing?.id === c.id ? (
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Textarea aria-label="Comment text" rows={3} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
                    <Input aria-label="Target post" placeholder="Target post link (optional)" value={editing.target} onChange={(e) => setEditing({ ...editing, target: e.target.value })} />
                    <div className="flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => void saveEdit()}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="line-clamp-3 whitespace-pre-wrap text-sm text-fg">{c.body}</p>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
                      <span className="truncate">{c.targetUrl ? `On ${c.targetUrl.replace('https://x.com/', '')}` : 'No target yet — choose the post in a campaign'}</span>
                      {c.usedAt && <StatusBadge tone="neutral">Used {formatRelative(c.usedAt)}</StatusBadge>}
                    </p>
                  </div>
                )}
                {editing?.id !== c.id && <IconButton label="Edit comment" icon={Pencil} size="sm" onClick={() => setEditing({ id: c.id, body: c.body, target: c.targetUrl ?? '' })} />}
              </li>
            ))}
          </ul>
        </>
      )}
      <ConfirmDialog
        open={confirm}
        title={`Delete ${shownChecked} ${shownChecked === 1 ? 'comment' : 'comments'}?`}
        description="They are removed from this device. Comments already posted on X stay on X."
        confirmLabel={`Delete ${shownChecked}`}
        tone="danger"
        busy={deleting}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void removeChecked()}
      />
    </Panel>
  )
}
