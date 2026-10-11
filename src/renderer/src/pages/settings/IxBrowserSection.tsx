import { PHASE } from '@shared/config/roadmap'
import { Notice, PhaseBadge } from '@/components/ui'
import { IxConnectionPanel } from './IxConnectionPanel'
import { ProviderManager } from './providers/ProviderManager'

export function IxBrowserSection() {
  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-medium text-fg">IX Browser</h2>
          <PhaseBadge phase={PHASE.ixBrowser} />
        </div>
        <p className="text-sm text-fg-subtle text-pretty">
          Browser profiles are read and opened through IX Browser’s Local API V2 on this computer. Only loopback addresses are accepted,
          so profile data never leaves your machine through Axora Relay.
        </p>
      </div>
      <IxConnectionPanel />
      <ProviderManager kind="ixbrowser" addLabel="Add IX Browser connection" />
      <Notice title="Setting up the Local API">
        In IX Browser, enable the Local API (API settings) and note its port — the default address is http://127.0.0.1:53200. The Local
        API needs no key: access is controlled by enabling it in IX Browser. Axora Relay uses only the documented V2 actions for listing,
        opening and closing profiles; it never reads cookies or saved passwords.
      </Notice>
    </>
  )
}
