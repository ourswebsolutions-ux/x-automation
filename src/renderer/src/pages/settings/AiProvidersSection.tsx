import { Bot, KeyRound, Pencil, PlugZap, Plus, Star, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { AI_ADAPTERS } from '@shared/config/aiAdapters'
import type { AiConnectionTest } from '@shared/types/ai'
import type { ProviderConfig } from '@shared/types/providers'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  Notice,
  Select,
  SettingsRow,
  SettingsSection,
  SkeletonRows,
  StatusBadge,
  Switch,
  Tooltip,
  useToast
} from '@/components/ui'
import { useAiOverview, useCachedModels } from '@/data/ai'
import { useCredentialStatus, useProviders } from '@/data/providers'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { usePreferences } from '@/state/preferences'
import { AiProviderDialog } from './ai/AiProviderDialog'
import { connectionState } from './ai/aiMeta'

export function AiProvidersSection() {
  const toast = useToast()
  const { preferences, update } = usePreferences()
  const providers = useProviders('openai-compatible')
  const credentials = useCredentialStatus()
  const overview = useAiOverview()
  const [dialog, setDialog] = useState<{ open: boolean; provider: ProviderConfig | null }>({ open: false, provider: null })
  const [pendingRemove, setPendingRemove] = useState<ProviderConfig | null>(null)
  const [removing, setRemoving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)

  const list = providers.data ?? []
  const tests = overview.data?.tests ?? {}
  const defaultId = preferences.defaults.textProviderId
  const enabled = list.filter((p) => p.enabled)
  const defaultProvider = list.find((p) => p.id === defaultId) ?? null

  const toggle = async (provider: ProviderConfig, next: boolean) => {
    try {
      const { kind, name, endpoint, model } = provider
      await relay.providers.update(provider.id, { kind, name, endpoint, model, enabled: next })
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not update', description: errorMessage(error) })
    }
  }

  const test = async (provider: ProviderConfig) => {
    setTesting(provider.id)
    try {
      const result = await relay.ai.testConnection(provider.id)
      toast(
        result.ok
          ? { tone: 'success', title: `“${provider.name}” is connected`, description: `${result.modelCount} models listed · ${result.latencyMs} ms` }
          : { tone: 'danger', title: `“${provider.name}” failed the test`, description: `${result.error?.message ?? ''} ${result.error?.hint ?? ''}`.trim(), duration: 9000 }
      )
    } catch (error) {
      toast({ tone: 'danger', title: 'Connection test failed', description: errorMessage(error), duration: 9000 })
    } finally {
      setTesting(null)
    }
  }

  const remove = async () => {
    if (!pendingRemove) return
    setRemoving(true)
    try {
      await relay.providers.remove(pendingRemove.id)
      toast({ tone: 'success', title: `Removed “${pendingRemove.name}”`, description: pendingRemove.credential ? 'Its stored key was deleted too. Usage history is kept.' : undefined })
      setPendingRemove(null)
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not remove', description: errorMessage(error) })
    } finally {
      setRemoving(false)
    }
  }

  const editing = dialog.provider ? (list.find((p) => p.id === dialog.provider!.id) ?? dialog.provider) : null

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-fg">AI providers</h2>
        <p className="text-sm text-fg-subtle text-pretty">
          OpenAI, and services with an OpenAI-compatible API (hosted, or local servers such as LM Studio and Ollama on this computer). Requests run in the
          background process with keys this window never sees. A provider shows as connected only after a real request succeeds.
        </p>
      </div>

      <div className="rounded-lg border border-line bg-surface-2">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <span className="text-xs text-fg-subtle">{providers.data ? `${list.length} provider${list.length === 1 ? '' : 's'}` : 'Loading…'}</span>
          <Button size="sm" variant="primary" icon={Plus} onClick={() => setDialog({ open: true, provider: null })}>
            Add AI provider
          </Button>
        </div>
        {providers.status === 'error' ? (
          <ErrorState size="sm" error={providers.error} onRetry={providers.reload} />
        ) : !providers.data ? (
          <SkeletonRows rows={2} className="p-4" />
        ) : list.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Bot}
            title="No AI providers yet"
            description="Add OpenAI with your API key, or point an OpenAI-compatible provider at its endpoint."
            actions={
              <Button size="sm" icon={Plus} onClick={() => setDialog({ open: true, provider: null })}>
                Add AI provider
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                test={tests[provider.id]}
                isDefault={provider.id === defaultId}
                testing={testing === provider.id}
                onTest={() => test(provider)}
                onEdit={() => setDialog({ open: true, provider })}
                onRemove={() => setPendingRemove(provider)}
                onToggle={(next) => toggle(provider, next)}
              />
            ))}
          </ul>
        )}
      </div>

      <SettingsSection title="Defaults" description="Used by AI features unless you choose otherwise there.">
        <SettingsRow
          label="Default text provider"
          htmlFor="default-text"
          description="Only enabled providers are listed."
          control={
            <Select<string>
              id="default-text"
              className="w-64"
              value={defaultId ?? 'none'}
              onChange={(value) => update({ defaults: { textProviderId: value === 'none' ? null : value } })}
              options={[{ value: 'none', label: 'None' }, ...enabled.map((p) => ({ value: p.id, label: p.name, description: AI_ADAPTERS[p.adapter ?? 'openai-chat'].label }))]}
            />
          }
        />
        <DefaultModelRow provider={defaultProvider} />
      </SettingsSection>


      <Notice icon={KeyRound} title="How AI keys are handled">
        Keys are encrypted by your operating system, kept out of the database and backups, and used only in the background process for the requests listed
        above. Endpoints inside private networks are refused, and redirects are never followed, so a key can’t be sent somewhere unexpected.
      </Notice>

      <AiProviderDialog
        open={dialog.open}
        provider={editing}
        test={editing ? tests[editing.id] : undefined}
        credentials={credentials.data}
        onClose={() => setDialog((d) => ({ ...d, open: false }))}
        onSaved={(saved) => {
          providers.reload()
          setDialog({ open: true, provider: saved })
        }}
      />
      <ConfirmDialog
        open={Boolean(pendingRemove)}
        title={`Remove “${pendingRemove?.name ?? ''}”?`}
        description="The configuration and its encrypted API key are deleted from this device. Its usage history stays for your records."
        confirmLabel="Remove provider"
        tone="danger"
        busy={removing}
        onCancel={() => setPendingRemove(null)}
        onConfirm={remove}
      />
    </>
  )
}

export function ProviderRow(props: {
  provider: ProviderConfig
  test: AiConnectionTest | undefined
  isDefault: boolean
  testing: boolean
  onTest: () => void
  onEdit: () => void
  onRemove: () => void
  onToggle: (enabled: boolean) => void
}) {
  const { provider: p } = props
  const state = connectionState(p, props.test)
  const meta = AI_ADAPTERS[p.adapter ?? 'openai-chat']
  const key = p.credential
  return (
    <li className="flex flex-col gap-2 px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md border border-line-strong bg-surface-3 text-fg-muted">
          <Bot size={15} strokeWidth={1.7} />
        </span>
        <button type="button" onClick={props.onEdit} className="flex min-w-0 flex-1 flex-col rounded-xs text-left focus-ring">
          <span className="flex items-center gap-2">
            <span className={cn('truncate text-sm', p.enabled ? 'text-fg' : 'text-fg-subtle')}>{p.name}</span>
            <span className="shrink-0 text-xs text-fg-faint">{meta.label}</span>
            {props.isDefault && (
              <StatusBadge tone="accent" icon={Star}>
                Default
              </StatusBadge>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-xs text-fg-subtle">
            <span className="truncate font-mono">{p.endpoint}</span>
            <span aria-hidden>·</span>
            <span className={cn('shrink-0 font-mono', !p.model && 'font-sans text-warning')}>{p.model ?? 'No model'}</span>
          </span>
        </button>
        <span className="hidden shrink-0 items-center gap-1.5 font-mono text-xs text-fg-subtle @2xl:flex">
          <KeyRound size={12} strokeWidth={1.8} />
          {key ? (key.present ? `••••${key.hint ?? '••••'}` : <span className="font-sans text-warning">Missing</span>) : <span className="font-sans">No key</span>}
        </span>
        <Tooltip content={state.detail ?? (props.test ? `Checked ${new Date(props.test.checkedAt).toLocaleString()}` : state.label)}>
          <span>
            <StatusBadge tone={state.tone} dot>
              {state.label}
            </StatusBadge>
          </span>
        </Tooltip>
        <Button size="sm" icon={PlugZap} loading={props.testing} disabled={p.readiness.state !== 'ready'} onClick={props.onTest}>
          Test
        </Button>
        <Switch checked={p.enabled} onChange={props.onToggle} aria-label={`Enable ${p.name}`} />
        <div className="flex shrink-0 items-center">
          <IconButton icon={Pencil} label="Edit" size="sm" onClick={props.onEdit} />
          <IconButton icon={Trash2} label="Remove" size="sm" onClick={props.onRemove} />
        </div>
      </div>
      {state.detail && (state.tone === 'danger' || state.tone === 'warning') && <p className={cn('ml-11 text-xs', state.tone === 'danger' ? 'text-danger' : 'text-warning')}>{state.detail}</p>}
    </li>
  )
}

/** Default model = the default provider's model, chosen from its own model list. */
function DefaultModelRow({ provider }: { provider: ProviderConfig | null }) {
  const toast = useToast()
  const models = useCachedModels(provider?.id ?? null)
  const textModels = (models.data?.models ?? []).filter((m) => m.likelyText).map((m) => m.id)
  const options = [...new Set([...(provider?.model ? [provider.model] : []), ...textModels])]

  const choose = async (model: string) => {
    if (!provider) return
    try {
      const { kind, name, endpoint, enabled } = provider
      await relay.providers.update(provider.id, { kind, name, endpoint, model, enabled })
      toast({ tone: 'success', title: 'Default model updated', description: model })
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not update the model', description: errorMessage(error) })
    }
  }

  return (
    <SettingsRow
      label="Default text model"
      htmlFor="default-model"
      description={
        !provider
          ? 'Choose a default provider first.'
          : models.data
            ? `From “${provider.name}”’s model list.`
            : `“${provider.name}”’s model list hasn’t been fetched — fetch it in the provider’s settings, or type an id there.`
      }
      control={
        <Select<string>
          id="default-model"
          className="w-64"
          disabled={!provider || options.length === 0}
          value={provider?.model ?? null}
          placeholder={provider ? 'No model selected' : '—'}
          onChange={choose}
          options={options.map((id) => ({ value: id, label: id }))}
        />
      }
    />
  )
}
