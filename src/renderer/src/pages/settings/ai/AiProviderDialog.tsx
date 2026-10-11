import { ExternalLink, PlugZap } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { AI_ADAPTERS, TEXT_ADAPTER_LIST, type AiAdapterId } from '@shared/config/aiAdapters'
import { keyRequired, validateEndpoint, validateModel, validateProviderName } from '@shared/config/providers'
import type { AiConnectionTest } from '@shared/types/ai'
import { DEFAULT_AI_SETTINGS, type ProviderConfig, type ProviderInput } from '@shared/types/providers'
import type { CredentialStatus } from '@shared/types/storage'
import { Button, ConfirmDialog, Field, Input, Modal, StatusBadge, Switch, useToast } from '@/components/ui'
import { ApiKeyBlock } from '../providers/ApiKeyBlock'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/format'
import { connectionState } from './aiMeta'
import { ModelPicker } from './ModelPicker'
import { TryPrompt } from './TryPrompt'

interface AiProviderDialogProps {
  open: boolean
  provider: ProviderConfig | null
  test: AiConnectionTest | undefined
  credentials: CredentialStatus | undefined
  onClose: () => void
  onSaved: (provider: ProviderConfig) => void
}

const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value))

export function AiProviderDialog({ open, provider, test, credentials, onClose, onSaved }: AiProviderDialogProps) {
  const toast = useToast()
  const [current, setCurrent] = useState<ProviderConfig | null>(provider)
  const [adapter, setAdapter] = useState<AiAdapterId>('openai')
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [timeoutSec, setTimeoutSec] = useState('60')
  const [retries, setRetries] = useState('1')
  const [temperature, setTemperature] = useState('')
  const [maxTokens, setMaxTokens] = useState('')
  const [secret, setSecret] = useState('')
  const [replacingKey, setReplacingKey] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [lastTest, setLastTest] = useState<AiConnectionTest | undefined>(test)
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false)

  useEffect(() => {
    if (!open) return
    const a = provider?.adapter ?? 'openai'
    const settings = provider?.settings ?? DEFAULT_AI_SETTINGS
    setCurrent(provider)
    setAdapter(a)
    setName(provider?.name ?? AI_ADAPTERS[a].defaultName)
    setEndpoint(provider?.endpoint ?? AI_ADAPTERS[a].defaultEndpoint)
    setModel(provider?.model ?? '')
    setEnabled(provider?.enabled ?? true)
    setTimeoutSec(String(settings.timeoutMs / 1000))
    setRetries(String(settings.retries))
    setTemperature(settings.generation?.temperature === null || settings.generation?.temperature === undefined ? '' : String(settings.generation.temperature))
    setMaxTokens(settings.generation?.maxOutputTokens ? String(settings.generation.maxOutputTokens) : '')
    setSecret('')
    setReplacingKey(false)
    setSubmitted(false)
    setServerError(null)
    setLastTest(test)
    // Reset only when the dialog opens or switches to another configuration.
  }, [open, provider?.id])

  useEffect(() => setLastTest(test), [test])
  // Keep key, readiness and timestamps fresh as the provider list reloads, without resetting the form.
  useEffect(() => {
    if (provider) setCurrent((existing) => (existing && existing.id === provider.id ? provider : existing))
  }, [provider])

  const meta = AI_ADAPTERS[adapter]
  const limits = meta.parameters
  const needsKey = keyRequired('openai-compatible', endpoint)
  const credential = current?.credential ?? null

  const t = numberOrNull(temperature)
  const m = numberOrNull(maxTokens)
  const errors = {
    name: validateProviderName(name),
    endpoint: validateEndpoint('openai-compatible', endpoint),
    model: model.trim() ? validateModel('openai-compatible', model) : null,
    timeout: !/^\d+$/.test(timeoutSec) || Number(timeoutSec) < 1 || Number(timeoutSec) > 120 ? 'Use 1–120 seconds.' : null,
    retries: !/^\d$/.test(retries) || Number(retries) > 5 ? 'Use 0–5.' : null,
    temperature: t !== null && (Number.isNaN(t) || t < limits.temperature.min || t > limits.temperature.max) ? `Use ${limits.temperature.min}–${limits.temperature.max}, or leave empty.` : null,
    maxTokens:
      m !== null && (!Number.isInteger(m) || m < limits.maxOutputTokens.min || m > limits.maxOutputTokens.max)
        ? `Use ${limits.maxOutputTokens.min}–${limits.maxOutputTokens.max.toLocaleString()}, or leave empty.`
        : null,
    secret: secret && secret.trim().length < 8 ? 'That key looks too short.' : /\s/.test(secret.trim()) ? 'Keys cannot contain spaces.' : null
  }
  const hasErrors = Object.values(errors).some(Boolean)

  const input = (): ProviderInput => ({
    kind: 'openai-compatible',
    adapter,
    name,
    endpoint,
    model: model.trim() || null,
    enabled,
    settings: { timeoutMs: Number(timeoutSec) * 1000, retries: Number(retries), generation: { temperature: t, maxOutputTokens: m } }
  })

  const dirty =
    current !== null &&
    (JSON.stringify({ ...input(), name: name.trim(), endpoint: endpoint.trim().replace(/\/+$/, '') }) !==
      JSON.stringify({
        kind: current.kind,
        adapter: current.adapter,
        name: current.name,
        endpoint: current.endpoint,
        model: current.model,
        enabled: current.enabled,
        settings: { timeoutMs: current.settings.timeoutMs, retries: current.settings.retries, generation: current.settings.generation ?? { temperature: null, maxOutputTokens: null } }
      }) ||
      Boolean(secret.trim()))

  const chooseAdapter = (next: AiAdapterId) => {
    setAdapter(next)
    setName(AI_ADAPTERS[next].defaultName)
    setEndpoint(AI_ADAPTERS[next].defaultEndpoint)
  }

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    setSubmitted(true)
    if (hasErrors) return
    setSaving(true)
    setServerError(null)
    let saved: ProviderConfig | null = null
    try {
      saved = current ? await relay.providers.update(current.id, input()) : await relay.providers.create(input())
      if (secret.trim()) saved = await relay.providers.setKey(saved.id, secret.trim())
      const created = !current
      setCurrent(saved)
      setSecret('')
      setReplacingKey(false)
      onSaved(saved)
      toast({
        tone: 'success',
        title: created ? 'AI provider added' : 'AI provider updated',
        description: secret.trim() ? 'The API key was encrypted and stored on this device.' : created ? 'Run a connection test to check it.' : undefined
      })
    } catch (error) {
      if (saved) {
        setCurrent(saved)
        onSaved(saved)
      }
      setServerError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const runTest = async () => {
    if (!current) return
    setTesting(true)
    try {
      const result = await relay.ai.testConnection(current.id)
      setLastTest(result)
    } catch (error) {
      setServerError(errorMessage(error))
    } finally {
      setTesting(false)
    }
  }

  const removeKey = async () => {
    if (!current) return
    try {
      const updated = await relay.providers.removeKey(current.id)
      setCurrent(updated)
      onSaved(updated)
      toast({ tone: 'success', title: 'API key removed' })
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not remove key', description: errorMessage(error) })
    } finally {
      setConfirmRemoveKey(false)
    }
  }

  const err = (field: keyof typeof errors) => (submitted || field === 'temperature' || field === 'maxTokens' || field === 'timeout' || field === 'retries' ? errors[field] : null)
  const savedReady = current?.readiness.state === 'ready'
  const status = current ? connectionState(current, lastTest) : null
  const canFetch = Boolean(current && current.enabled && !current.readiness.issues.some((i) => /key|endpoint/i.test(i)))

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        dismissible={!saving}
        size="lg"
        title={current ? `Edit ${current.name}` : 'Add AI provider'}
        description={current ? `${meta.label} · ${meta.api}` : 'Connect OpenAI, or any service with an OpenAI-compatible API.'}
        footer={
          <>
            {current && dirty && <span className="mr-auto text-xs text-warning">Unsaved changes — tests use the saved settings.</span>}
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {current ? 'Close' : 'Cancel'}
            </Button>
            <Button variant="primary" type="submit" form="ai-provider-form" loading={saving} disabled={Boolean(current) && !dirty}>
              {current ? 'Save changes' : 'Add provider'}
            </Button>
          </>
        }
      >
        <form id="ai-provider-form" onSubmit={submit} noValidate className="flex flex-col gap-5">
          {serverError && (
            <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
              {serverError}
            </div>
          )}

          {!current && (
            <fieldset className="flex flex-col gap-2">
              <legend className="pb-1.5 text-xs font-medium text-fg-muted">Type</legend>
              <div role="radiogroup" aria-label="Provider type" className="grid grid-cols-2 gap-2">
                {TEXT_ADAPTER_LIST.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={adapter === a.id}
                    onClick={() => chooseAdapter(a.id)}
                    className={cn(
                      'flex flex-col gap-1 rounded-md border px-3 py-2.5 text-left transition-colors focus-ring',
                      adapter === a.id ? 'border-accent-line bg-accent-soft' : 'border-line-strong bg-surface-1 hover:border-line-heavy'
                    )}
                  >
                    <span className="text-sm font-medium text-fg">{a.label}</span>
                    <span className="text-xs text-fg-subtle">{a.description}</span>
                    <span className="font-mono text-2xs text-fg-faint">{a.api}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" htmlFor="ai-name" error={err('name')}>
              <Input id="ai-name" data-autofocus value={name} maxLength={60} spellCheck={false} invalid={Boolean(err('name'))} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field
              label="Endpoint"
              htmlFor="ai-endpoint"
              error={err('endpoint') ?? (endpoint.trim() && validateEndpoint('openai-compatible', endpoint) ? validateEndpoint('openai-compatible', endpoint) : null)}
              hint={meta.endpointEditable ? 'Base URL ending in /v1. https:// for remote services; 127.0.0.1 for local servers.' : 'OpenAI’s API base URL.'}
              aside={
                endpoint !== meta.defaultEndpoint && (
                  <button type="button" onClick={() => setEndpoint(meta.defaultEndpoint)} className="rounded-xs text-xs text-accent-text hover:underline focus-ring">
                    Use default
                  </button>
                )
              }
            >
              <Input id="ai-endpoint" value={endpoint} spellCheck={false} invalid={Boolean(errors.endpoint && endpoint.trim())} onChange={(e) => setEndpoint(e.target.value)} className="font-mono text-xs" />
            </Field>
          </div>

          <ApiKeyBlock
            id="ai-secret"
            credential={credential}
            credentials={credentials}
            needsKey={needsKey}
            secret={secret}
            onSecret={setSecret}
            replacing={replacingKey}
            onReplace={() => setReplacingKey(true)}
            onRemove={() => setConfirmRemoveKey(true)}
            error={err('secret')}
          />

          <Field label="Model" htmlFor="ai-model" error={err('model')} aside={<span className="text-2xs text-fg-faint">Needed before generating</span>}>
            <ModelPicker id="ai-model" providerId={current?.id ?? null} canFetch={canFetch} value={model} onChange={setModel} invalid={Boolean(err('model'))} />
          </Field>

          <div className="grid grid-cols-2 gap-4 @2xl:grid-cols-4">
            <Field label="Timeout (s)" htmlFor="ai-timeout" error={err('timeout')}>
              <Input id="ai-timeout" inputMode="numeric" value={timeoutSec} invalid={Boolean(err('timeout'))} onChange={(e) => setTimeoutSec(e.target.value)} />
            </Field>
            <Field label="Retries" htmlFor="ai-retries" error={err('retries')}>
              <Input id="ai-retries" inputMode="numeric" value={retries} invalid={Boolean(err('retries'))} onChange={(e) => setRetries(e.target.value)} />
            </Field>
            <Field label="Temperature" htmlFor="ai-temperature" error={err('temperature')}>
              <Input id="ai-temperature" inputMode="decimal" placeholder="Default" value={temperature} invalid={Boolean(err('temperature'))} onChange={(e) => setTemperature(e.target.value)} />
            </Field>
            <Field label="Max output tokens" htmlFor="ai-max-tokens" error={err('maxTokens')}>
              <Input id="ai-max-tokens" inputMode="numeric" placeholder="Default" value={maxTokens} invalid={Boolean(err('maxTokens'))} onChange={(e) => setMaxTokens(e.target.value)} />
            </Field>
          </div>
          <p className="-mt-3 text-xs text-fg-subtle">
            Retries apply to model listing only — generation is never repeated automatically, because each attempt is billed. Leave generation defaults empty to use
            the provider’s own; some models reject a temperature setting.
          </p>

          <label className="flex items-center justify-between gap-3">
            <span className="flex flex-col">
              <span className="text-sm text-fg">Enabled</span>
              <span className="text-xs text-fg-subtle">Disabled providers are kept but never used.</span>
            </span>
            <Switch checked={enabled} onChange={setEnabled} aria-label="Enabled" />
          </label>
          <button type="submit" hidden />
        </form>

        {current && status && (
          <section aria-label="Connection" className="mt-5 flex flex-col gap-3 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-fg">Connection</span>
              <StatusBadge tone={status.tone} dot>
                {status.label}
              </StatusBadge>
              {lastTest && <span className="text-xs text-fg-subtle">checked {formatRelative(lastTest.checkedAt)}{lastTest.ok && lastTest.latencyMs !== null ? ` · ${lastTest.latencyMs} ms · ${lastTest.modelCount} models` : ''}</span>}
              <span className="flex-1" />
              <a href={meta.docsUrl} onClick={(e) => (e.preventDefault(), void relay.shell.openExternal(meta.docsUrl))} className="flex items-center gap-1 rounded-xs text-xs text-fg-subtle hover:text-fg focus-ring">
                API reference <ExternalLink size={11} />
              </a>
              <Button size="sm" icon={PlugZap} loading={testing} disabled={!savedReady && !canFetch} onClick={runTest}>
                Test connection
              </Button>
            </div>
            {status.detail && <p className={cn('text-xs', status.tone === 'danger' ? 'text-danger' : status.tone === 'warning' ? 'text-warning' : 'text-fg-subtle')}>{status.detail}</p>}
            <p className="text-xs text-fg-faint">The test lists models with the saved key (GET /models). It is free and does not generate anything.</p>
            <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3.5">
              <span className="text-sm font-medium text-fg">Try a prompt</span>
              <TryPrompt
                providerId={current.id}
                disabledReason={!savedReady ? 'Complete and save the configuration (key and model) first.' : dirty ? 'Save your changes first.' : null}
              />
            </div>
          </section>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmRemoveKey}
        title="Remove the stored API key?"
        description="The encrypted key is deleted from this device. The configuration stays and will show as incomplete."
        confirmLabel="Remove key"
        tone="danger"
        onCancel={() => setConfirmRemoveKey(false)}
        onConfirm={removeKey}
      />
    </>
  )
}
