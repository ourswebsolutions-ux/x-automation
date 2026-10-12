import { Globe, Shield, UsersRound } from 'lucide-react'
import { PageHeader, Tabs } from '@/components/ui'
import { useAccounts } from '@/data/accounts'
import { useIxOverview } from '@/data/ixbrowser'
import { useProxies } from '@/data/proxies'
import { useQueryParam } from '@/hooks/useQueryParam'
import { NAV_ITEMS } from '@/app/navigation'
import { AccountsView } from './AccountsView'
import { ProfilesView } from './ProfilesView'
import { ProxiesView } from './ProxiesView'

type View = 'accounts' | 'profiles' | 'proxies'

export function AccountsPage() {
  const [viewParam, setView] = useQueryParam('view')
  // Profiles first: syncing links every profile to an account, so the accounts list is for details (usernames, enable/disable).
  const view: View = viewParam === 'accounts' || viewParam === 'proxies' ? viewParam : 'profiles'
  const overview = useIxOverview()
  const accounts = useAccounts()
  const proxies = useProxies()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={NAV_ITEMS.accounts.label} description={NAV_ITEMS.accounts.description} />
      <Tabs<View>
        aria-label="Profiles, accounts and proxies"
        value={view}
        onChange={(next) => setView(next === 'profiles' ? '' : next)}
        items={[
          { value: 'profiles', label: 'Profiles', icon: Globe, count: overview.data?.counts.total },
          { value: 'accounts', label: 'X accounts', icon: UsersRound, count: accounts.data?.length },
          { value: 'proxies', label: 'Proxies', icon: Shield, count: proxies.data?.length }
        ]}
      />
      {view === 'accounts' ? <AccountsView /> : view === 'profiles' ? <ProfilesView /> : <ProxiesView />}
    </div>
  )
}
