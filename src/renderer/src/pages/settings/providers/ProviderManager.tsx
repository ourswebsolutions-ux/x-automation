import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { PROVIDER_KINDS } from '@shared/config/providers'
import type { ProviderConfig, ProviderKind } from '@shared/types/providers'
import { Button, ConfirmDialog, EmptyState, ErrorState, IconButton, SkeletonRows, StatusBadge, Switch, useToast } from '@/components/ui'
import { useAiOverview } from '@/data/ai'
import { useCredentialStatus, useProviders } from '@/data/providers'
import { AiProviderDialog } from '../ai/AiProviderDialog'
import { ImageProviderDialog } from '../ai/ImageProviderDialog'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { KIND_ICON, READINESS } from './providerMeta'
import { ProviderDialog } from './ProviderDialog'

interface ProviderManagerProps {
  kind?: ProviderKind
  addLabel?: string
}

/** List, add, edit, enable/disable and remove provider configurations. */
export function ProviderManager({ kind, addLabel = 'Add configuration' }: ProviderManagerProps) {
  const toast = useToast()
  const providers = useProviders(kind)
  const credentials = useCredentialStatus()
  const [dialog, setDialog] = useState<{ open: boolean; provider: ProviderConfig | null }>({ open: false, provider: null })
  const [aiDialog, setAiDialog] = useState<ProviderConfig | null>(null)
  const [imageDialog, setImageDialog] = useState<ProviderConfig | null>(null)
  const aiOverview = useAiOverview()
  const [pendingRemove, setPendingRemove] = useState<ProviderConfig | null>(null)
  const [removing, setRemoving] = useState(false)

  const toggle = async (provider: ProviderConfig, enabled: boolean) => {
    try {
      const { kind, name, endpoint, model } = provider
      await relay.providers.update(provider.id, { kind, name, endpoint, model, enabled })
      providers.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not update', description: errorMessage(error) })
    }
  }

  const remove = async () => {
    if (!pendingRemove) return
    setRemoving(true)
    try {
      await relay.providers.remove(pendingRemove.id)
      toast({ tone: 'success', title: `Removed “${pendingRemove.name}”`, description: pendingRemove.credential ? 'Its stored key was deleted too.' : undefined })
      providers.reload()
      setPendingRemove(null)
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not remove', description: errorMessage(error) })
    } finally {
      setRemoving(false)
    }
  }

  const list = providers.data ?? []

  return (
    <div className="rounded-lg border border-line bg-surface-2">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="text-xs text-fg-subtle">
          {providers.data ? `${list.length} configuration${list.length === 1 ? '' : 's'}` : 'Loading…'}
        </span>
        <Button size="sm" variant="primary" icon={Plus} onClick={() => setDialog({ open: true, provider: null })}>
          {addLabel}
        </Button>
      </div>

      {providers.status === 'error' ? (
        <ErrorState size="sm" error={providers.error} onRetry={providers.reload} />
      ) : !providers.data ? (
        <SkeletonRows rows={2} className="p-4" />
      ) : list.length === 0 ? (
        <EmptyState
          size="sm"
          icon={kind ? KIND_ICON[kind] : KeyRound}
          title="No configurations yet"
          description={kind ? PROVIDER_KINDS[kind].description : 'Add IX Browser, AI text or image generation services.'}
          actions={
            <Button size="sm" icon={Plus} onClick={() => setDialog({ open: true, provider: null })}>
              {addLabel}
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-line">
          {list.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              showKind={!kind}
              onEdit={() => (provider.kind === 'openai-compatible' ? setAiDialog(provider) : provider.kind === 'image' ? setImageDialog(provider) : setDialog({ open: true, provider }))}
              onRemove={() => setPendingRemove(provider)}
              onToggle={(enabled) => toggle(provider, enabled)}
            />
          ))}
        </ul>
      )}

      <ProviderDialog
        open={dialog.open}
        provider={dialog.provider}
        fixedKind={kind}
        credentials={credentials.data}
        onClose={() => setDialog((d) => ({ ...d, open: false }))}
        onSaved={() => providers.reload()}
      />

      <AiProviderDialog
        open={Boolean(aiDialog)}
        provider={aiDialog ? (list.find((p) => p.id === aiDialog.id) ?? aiDialog) : null}
        test={aiDialog ? aiOverview.data?.tests[aiDialog.id] : undefined}
        credentials={credentials.data}
        onClose={() => setAiDialog(null)}
        onSaved={(saved) => {
          providers.reload()
          setAiDialog(saved)
        }}
      />

      <ImageProviderDialog
        open={Boolean(imageDialog)}
        provider={imageDialog ? (list.find((p) => p.id === imageDialog.id) ?? imageDialog) : null}
        test={imageDialog ? aiOverview.data?.tests[imageDialog.id] : undefined}
        credentials={credentials.data}
        onClose={() => setImageDialog(null)}
        onSaved={(saved) => {
          providers.reload()
          setImageDialog(saved)
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingRemove)}
        title={`Remove “${pendingRemove?.name ?? ''}”?`}
        description="The configuration and its encrypted API key are deleted from this device. This can't be undone."
        confirmLabel="Remove configuration"
        tone="danger"
        busy={removing}
        onCancel={() => setPendingRemove(null)}
        onConfirm={remove}
      />
    </div>
  )
}

interface RowProps {
  provider: ProviderConfig
  showKind: boolean
  onEdit: () => void
  onRemove: () => void
  onToggle: (enabled: boolean) => void
}

function ProviderRow({ provider, showKind, onEdit, onRemove, onToggle }: RowProps) {
  const Icon = KIND_ICON[provider.kind]
  const readiness = READINESS[provider.readiness.state]
  const meta = PROVIDER_KINDS[provider.kind]
  const key = provider.credential

  return (
    <li className="group flex flex-col gap-2 px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-line-strong bg-surface-3 text-fg-muted">
          <Icon size={15} strokeWidth={1.7} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2">
            <span className={cn('truncate text-sm', provider.enabled ? 'text-fg' : 'text-fg-subtle')}>{provider.name}</span>
            {showKind && <span className="truncate text-xs text-fg-faint">{meta.label}</span>}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-xs text-fg-subtle">
            <span className="truncate font-mono">{provider.endpoint}</span>
            {provider.model && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 font-mono">{provider.model}</span>
              </>
            )}
          </span>
        </div>
        {provider.kind !== 'ixbrowser' && (
        <span className="hidden shrink-0 items-center gap-1.5 font-mono text-xs text-fg-subtle @2xl:flex">
          <KeyRound size={12} strokeWidth={1.8} />
          {key ? (key.present ? `••••${key.hint ?? '••••'}` : <span className="font-sans text-warning">Missing</span>) : <span className="font-sans">No key</span>}
        </span>
        )}
        <StatusBadge tone={readiness.tone} dot>
          {readiness.label}
        </StatusBadge>
        <Switch checked={provider.enabled} onChange={onToggle} aria-label={`Enable ${provider.name}`} />
        <div className="flex shrink-0 items-center">
          <IconButton icon={Pencil} label="Edit" size="sm" onClick={onEdit} />
          <IconButton icon={Trash2} label="Remove" size="sm" onClick={onRemove} />
        </div>
      </div>
      {provider.readiness.state === 'incomplete' && (
        <ul className="ml-11 flex flex-col gap-0.5">
          {provider.readiness.issues.map((issue) => (
            <li key={issue} className="text-xs text-warning">
              {issue}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
