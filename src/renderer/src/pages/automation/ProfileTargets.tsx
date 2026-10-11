import { RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { TargetSettings } from '@shared/types/automation'
import { Button, Checkbox, Field, SearchField, SegmentedControl, StatusBadge, Switch, useToast } from '@/components/ui'
import { useBrowserProfiles } from '@/data/ixbrowser'
import { useAccounts } from '@/data/accounts'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'

interface Props {
  value: TargetSettings
  onChange: (next: TargetSettings) => void
  publishing: boolean
}

/** All Profiles (default) or a selection, plus how posts are spread over them. */
export function ProfileTargets({ value, onChange, publishing }: Props) {
  const toast = useToast()
  const profiles = useBrowserProfiles()
  const accounts = useAccounts()
  const [query, setQuery] = useState('')
  const [syncing, setSyncing] = useState(false)
  const list = profiles.data ?? []
  const byProfile = useMemo(() => new Map((accounts.data ?? []).filter((a) => a.profile).map((a) => [a.profile!.id, a])), [accounts.data])
  const shown = list.filter((p) => !query.trim() || `${p.name} ${p.externalId}`.toLowerCase().includes(query.trim().toLowerCase()))
  const selected = value.scope === 'all' ? list : list.filter((p) => value.profileIds.includes(p.id))
  const available = selected.filter((p) => p.availability === 'available').length
  const set = (patch: Partial<TargetSettings>) => onChange({ ...value, ...patch })
  const toggle = (id: string, on: boolean) => set({ profileIds: on ? [...new Set([...value.profileIds, id])] : value.profileIds.filter((x) => x !== id) })

  const sync = async () => {
    setSyncing(true)
    try {
      await relay.ixbrowser.sync()
      profiles.reload()
      toast({ tone: 'success', title: 'Profiles refreshed' })
    } catch (error) {
      toast({ tone: 'danger', title: 'Profiles could not be refreshed', description: errorMessage(error) })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl<TargetSettings['scope']>
          value={value.scope}
          onChange={(scope) => set({ scope })}
          options={[
            { value: 'all', label: 'All profiles' },
            { value: 'selected', label: 'Selected profiles' }
          ]}
        />
        <span className="text-xs text-fg-subtle" aria-live="polite">
          {list.length === 0 ? 'No profiles synced yet.' : `${selected.length} selected · ${available} available · ${selected.length - available} unavailable`}
        </span>
        <Button size="sm" variant="ghost" icon={RefreshCw} loading={syncing} onClick={sync} className="ml-auto">
          Refresh
        </Button>
      </div>

      {value.scope === 'selected' && (
        <div className="flex flex-col gap-2 rounded-md border border-line">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <SearchField value={query} onChange={setQuery} placeholder="Search by name or ID" size="sm" className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => set({ profileIds: [...new Set([...value.profileIds, ...shown.map((p) => p.id)])] })}>
              Select all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => set({ profileIds: value.profileIds.filter((id) => !shown.some((p) => p.id === id)) })}>
              Deselect all
            </Button>
          </div>
          <ul className="max-h-64 overflow-y-auto" aria-label="Profiles">
            {shown.map((p) => {
              const account = byProfile.get(p.id)
              const checked = value.profileIds.includes(p.id)
              return (
                <li key={p.id} className={cn('flex items-center gap-3 px-3 py-1.5 text-sm', checked && 'bg-accent-soft/30')}>
                  <Checkbox checked={checked} onChange={(on) => toggle(p.id, on)} aria-label={`Select ${p.name}`} />
                  <span className="min-w-0 flex-1 truncate text-fg">{p.name}</span>
                  <span className="truncate text-xs text-fg-subtle">{account ? (account.handle ? `@${account.handle}` : account.label) : 'No account'}</span>
                  <StatusBadge tone={p.availability === 'available' ? (p.runState === 'running' ? 'info' : 'success') : 'neutral'} dot>
                    {p.availability !== 'available' ? 'Unavailable' : p.runState === 'running' ? 'Open' : 'Ready'}
                  </StatusBadge>
                </li>
              )
            })}
            {shown.length === 0 && <li className="px-3 py-3 text-xs text-fg-subtle">No profiles match.</li>}
          </ul>
        </div>
      )}

      <Field label="Posts and profiles" htmlFor="distribution">
        <SegmentedControl<TargetSettings['distribution']>
          value={value.distribution}
          onChange={(distribution) => set({ distribution })}
          options={[
            { value: 'unique', label: 'Different posts per profile' },
            { value: 'same', label: 'Same posts on every profile' },
            { value: 'drafts', label: 'Save as drafts only' }
          ]}
        />
      </Field>
      {value.distribution === 'same' && (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="flex flex-col">
            <span className="text-fg">Allow repeated content</span>
            <span className="text-xs text-fg-subtle">The same text on several accounts can be limited by X.</span>
          </span>
          <Switch checked={value.allowDuplicates} onChange={(allowDuplicates) => set({ allowDuplicates })} aria-label="Allow repeated content" />
        </label>
      )}
      {publishing && (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="flex flex-col">
            <span className="text-fg">Check the signed-in account before posting</span>
            <span className="text-xs text-fg-subtle">Only accounts with a confirmed X username are used. Turn off to also use the others (posting without that check).</span>
          </span>
          <Switch
            checked={value.requireConfirmedIdentity}
            onChange={(requireConfirmedIdentity) => set({ requireConfirmedIdentity, createMissingAccounts: requireConfirmedIdentity ? false : value.createMissingAccounts })}
            aria-label="Check the signed-in account before posting"
          />
        </label>
      )}
      {publishing && !value.requireConfirmedIdentity && (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="flex flex-col">
            <span className="text-fg">Include profiles without an account record</span>
            <span className="text-xs text-fg-subtle">A local account record (username unknown) is created for each.</span>
          </span>
          <Switch checked={value.createMissingAccounts} onChange={(createMissingAccounts) => set({ createMissingAccounts })} aria-label="Include profiles without an account record" />
        </label>
      )}
    </div>
  )
}
