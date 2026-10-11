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
  const view: View = viewParam === 'profiles' || viewParam === 'proxies' ? viewParam : 'accounts'
  const overview = useIxOverview()
  const accounts = useAccounts()
  const proxies = useProxies()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={NAV_ITEMS.accounts.label} description={NAV_ITEMS.accounts.description} />
      <Tabs<View>
        aria-label="Accounts and profiles"
        value={view}
        onChange={(next) => setView(next === 'accounts' ? '' : next)}
        items={[
          { value: 'accounts', label: 'X accounts', icon: UsersRound, count: accounts.data?.length },
          { value: 'profiles', label: 'Browser profiles', icon: Globe, count: overview.data?.counts.total },
          { value: 'proxies', label: 'Proxies', icon: Shield, count: proxies.data?.length }
        ]}
      />
      {view === 'accounts' ? <AccountsView /> : view === 'profiles' ? <ProfilesView /> : <ProxiesView />}
    </div>
  )
}
