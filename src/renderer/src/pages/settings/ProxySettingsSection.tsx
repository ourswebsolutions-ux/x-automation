import { ArrowRight, Shield } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button, Select, SettingsRow, SettingsSection, Skeleton, useToast } from '@/components/ui'
import { useProxies, useProxyAssignments } from '@/data/proxies'
import { errorMessage, relay } from '@/lib/bridge'
import { pluralize } from '@/lib/format'

/** Settings → Proxies: the essentials here; proxies themselves are managed in Accounts & Profiles. */
export function ProxySettingsSection() {
  const navigate = useNavigate()
  const toast = useToast()
  const proxies = useProxies()
  const assignments = useProxyAssignments()
  const list = proxies.data ?? []
  const working = list.filter((p) => p.lastTest?.ok).length
  const failing = list.filter((p) => p.lastTest && !p.lastTest.ok).length
  const current = list.find((p) => p.isDefault) ?? null

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-fg">Proxies</h2>
        <p className="text-sm text-fg-subtle text-pretty">
          Proxies are applied to IX Browser profiles through IX Browser’s own proxy setting. Passwords are encrypted on this computer. Axora Relay never switches
          proxies by itself.
        </p>
      </div>
      {!proxies.data ? (
        <Skeleton className="h-28" />
      ) : (
        <SettingsSection title="Proxy configuration">
          <SettingsRow
            label="Your proxies"
            description={
              list.length
                ? `${pluralize(list.length, 'proxy', 'proxies')} · ${working} working · ${failing} failing · assigned to ${pluralize((assignments.data ?? []).length, 'profile')}`
                : 'No proxies yet.'
            }
            control={
              <Button icon={Shield} trailingIcon={ArrowRight} onClick={() => navigate('/accounts?view=proxies')}>
                Manage proxies
              </Button>
            }
          />
          <SettingsRow
            label="Default proxy"
            htmlFor="default-proxy"
            description="Suggested when assigning, and can be applied to profiles without a proxy from the proxy manager."
            control={
              <Select<string>
                id="default-proxy"
                size="sm"
                className="w-56"
                value={current?.id ?? 'none'}
                onChange={async (id) => {
                  try {
                    await relay.proxies.setDefault(id === 'none' ? null : id)
                    proxies.reload()
                    toast({ tone: 'success', title: id === 'none' ? 'Default proxy cleared' : 'Default proxy set' })
                  } catch (error) {
                    toast({ tone: 'danger', title: 'Not changed', description: errorMessage(error) })
                  }
                }}
                options={[{ value: 'none', label: 'None' }, ...list.filter((p) => p.enabled).map((p) => ({ value: p.id, label: p.label }))]}
              />
            }
          />
        </SettingsSection>
      )}
    </>
  )
}
