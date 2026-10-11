import { Download, Link2, ListTodo, Plus, Upload } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button, PageHeader, Tabs, useToast } from '@/components/ui'
import { useAccounts } from '@/data/accounts'
import { useEngagementCounts, useLinks } from '@/data/links'
import { useQueryParam } from '@/hooks/useQueryParam'
import { errorMessage, relay } from '@/lib/bridge'
import { pluralize } from '@/lib/format'
import { NAV_ITEMS } from '@/app/navigation'
import { AddLinksDialog } from './AddLinksDialog'
import { EngagementView } from './EngagementView'
import { LinksView } from './LinksView'

type View = 'links' | 'engagement'

export function LinksPage() {
  const toast = useToast()
  const [viewParam, setViewParam] = useQueryParam('view')
  const view: View = viewParam === 'engagement' ? 'engagement' : 'links'
  const links = useLinks()
  const accounts = useAccounts()
  const counts = useEngagementCounts()
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const knownTags = useMemo(() => [...new Set((links.data ?? []).flatMap((l) => l.tags))].sort((a, b) => a.localeCompare(b)), [links.data])

  const doImport = async () => {
    setBusy(true)
    try {
      const r = await relay.links.import()
      if (r.cancelled) return
      const extra = [r.duplicates.length ? `${pluralize(r.duplicates.length, 'link')} already saved` : '', r.rejected.slice(0, 2).map((x) => `line ${x.line}: ${x.reason}`).join(' · ')].filter(Boolean).join(' · ')
      toast({ tone: r.rejected.length ? 'warning' : 'success', title: `${pluralize(r.added.length, 'link')} imported`, description: extra || undefined, duration: 9000 })
    } catch (error) {
      toast({ tone: 'danger', title: 'Import failed', description: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }
  const doExport = async () => {
    try {
      const r = await relay.links.export()
      if (!r.cancelled) toast({ tone: 'success', title: `Exported ${pluralize(r.count ?? 0, 'link')}`, description: r.fileName })
    } catch (error) {
      toast({ tone: 'danger', title: 'Export failed', description: errorMessage(error) })
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={NAV_ITEMS.links.label}
        description="Links to posts, and the engagement you plan for them. Saved on this device only."
        actions={
          <>
            <Button variant="ghost" icon={Upload} loading={busy} onClick={doImport}>
              Import
            </Button>
            <Button variant="ghost" icon={Download} disabled={!links.data?.length} onClick={doExport}>
              Export CSV
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
              Add links
            </Button>
          </>
        }
      />
      <Tabs<View>
        aria-label="Post links sections"
        value={view}
        onChange={(v) => setViewParam(v === 'links' ? '' : v)}
        items={[
          { value: 'links', label: 'Links', icon: Link2, count: links.data?.length },
          { value: 'engagement', label: 'Engagement', icon: ListTodo, count: counts.data?.open }
        ]}
      />
      {view === 'links' ? (
        <LinksView links={links.data ?? []} loading={links.status === 'loading' && !links.data} accounts={accounts.data ?? []} knownTags={knownTags} onAdd={() => setAdding(true)} />
      ) : (
        <EngagementView accounts={accounts.data ?? []} />
      )}
      <AddLinksDialog open={adding} accounts={accounts.data ?? []} knownTags={knownTags} onClose={() => setAdding(false)} />
    </div>
  )
}
