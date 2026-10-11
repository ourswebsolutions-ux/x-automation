import { ExternalLink, PlugZap } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { AI_ADAPTERS } from '@shared/config/aiAdapters'
import { imageModelCapabilities, SIZE_LABEL, type ImageFormat } from '@shared/config/imageModels'
import { keyRequired, validateEndpoint, validateModel, validateProviderName } from '@shared/config/providers'
import type { AiConnectionTest } from '@shared/types/ai'
import { DEFAULT_IMAGE_SETTINGS, type ProviderConfig, type ProviderInput } from '@shared/types/providers'
import type { CredentialStatus } from '@shared/types/storage'
import { Button, ConfirmDialog, Field, Input, Modal, Select, StatusBadge, Switch, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/format'
import { ApiKeyBlock } from '../providers/ApiKeyBlock'
import { connectionState } from './aiMeta'
import { ModelPicker } from './ModelPicker'

interface ImageProviderDialogProps {
  open: boolean
  provider: ProviderConfig | null
  test: AiConnectionTest | undefined
  credentials: CredentialStatus | undefined
  onClose: () => void
  onSaved: (provider: ProviderConfig) => void
}

const meta = AI_ADAPTERS['openai-images']

/** Add or edit an image generation provider (Images API). */
export function ImageProviderDialog({ open, provider, test, credentials, onClose, onSaved }: ImageProviderDialogProps) {
  const toast = useToast()
  const [current, setCurrent] = useState<ProviderConfig | null>(provider)
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [timeoutSec, setTimeoutSec] = useState('120')
  const [retries, setRetries] = useState('1')
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState<string | null>(null)
  const [format, setFormat] = useState<ImageFormat | null>(null)
  const [secret, setSecret] = useState('')
  const [replacingKey, setReplacingKey] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [lastTest, setLastTest] = useState(test)
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false)

  useEffect(() => {
    if (!open) return
    const settings = provider?.settings ?? DEFAULT_IMAGE_SETTINGS
    setCurrent(provider)
    setName(provider?.name ?? meta.defaultName)
    setEndpoint(provider?.endpoint ?? meta.defaultEndpoint)
    setModel(provider?.model ?? '')
    setEnabled(provider?.enabled ?? true)
    setTimeoutSec(String(settings.timeoutMs / 1000))
    setRetries(String(settings.retries))
    setSize(settings.image?.size ?? '1024x1024')
    setQuality(settings.image?.quality ?? null)
    setFormat(settings.image?.format ?? null)
    setSecret('')
    setReplacingKey(false)
    setSubmitted(false)
    setServerError(null)
    setLastTest(test)
  }, [open, provider?.id])

  useEffect(() => setLastTest(test), [test])
  useEffect(() => {
    if (provider) setCurrent((existing) => (existing && existing.id === provider.id ? provider : existing))
  }, [provider])

  const caps = useMemo(() => imageModelCapabilities(model.trim() || null), [model])
  // Defaults always stay within what the selected model supports.
  useEffect(() => {
    setSize((s) => (caps.sizes.includes(s) ? s : caps.sizes[0]!))
    setQuality((q) => (caps.qualities ? (q && caps.qualities.includes(q) ? q : caps.qualities[0]!) : null))
    setFormat((f) => (caps.formats ? (f && caps.formats.includes(f) ? f : 'jpeg') : null))
  }, [caps])

  const needsKey = keyRequired('image', endpoint)
  const credential = current?.credential ?? null
  const errors = {
    name: validateProviderName(name),
    endpoint: validateEndpoint('image', endpoint),
    model: model.trim() ? validateModel('image', model) : null,
    timeout: !/^\d+$/.test(timeoutSec) || Number(timeoutSec) < 1 || Number(timeoutSec) > 120 ? 'Use 1–120 seconds.' : null,
    retries: !/^\d$/.test(retries) || Number(retries) > 5 ? 'Use 0–5.' : null,
    secret: secret && secret.trim().length < 8 ? 'That key looks too short.' : /\s/.test(secret.trim()) ? 'Keys cannot contain spaces.' : null
  }
  const hasErrors = Object.values(errors).some(Boolean)
  const err = (field: keyof typeof errors) => (submitted || field === 'timeout' || field === 'retries' ? errors[field] : null)

  const input = (): ProviderInput => ({
    kind: 'image',
    adapter: 'openai-images',
    name,
    endpoint,
    model: model.trim() || null,
    enabled,
    settings: { timeoutMs: Number(timeoutSec) * 1000, retries: Number(retries), image: { size, quality, format } }
  })

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
      toast({ tone: 'success', title: created ? 'Image provider added' : 'Image provider updated', description: created ? 'Run a connection test to check it.' : undefined })
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
      setLastTest(await relay.ai.testConnection(current.id))
    } catch (error) {
      setServerError(errorMessage(error))
    } finally {
      setTesting(false)
    }
  }

  const status = current ? connectionState(current, lastTest) : null
  const canFetch = Boolean(current && current.enabled && !current.readiness.issues.some((i) => /key|endpoint/i.test(i)))

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        dismissible={!saving}
        size="lg"
        title={current ? `Edit ${current.name}` : 'Add image provider'}
        description={`${meta.description} ${meta.api}.`}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {current ? 'Close' : 'Cancel'}
            </Button>
            <Button variant="primary" type="submit" form="image-provider-form" loading={saving}>
              {current ? 'Save changes' : 'Add provider'}
            </Button>
          </>
        }
      >
        <form id="image-provider-form" onSubmit={submit} noValidate className="flex flex-col gap-5">
          {serverError && (
            <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
              {serverError}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" htmlFor="img-name" error={err('name')}>
              <Input id="img-name" data-autofocus value={name} maxLength={60} invalid={Boolean(err('name'))} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Endpoint" htmlFor="img-endpoint" error={endpoint.trim() ? errors.endpoint : err('endpoint')} hint="OpenAI’s API, or a service with the same Images API (https://).">
              <Input id="img-endpoint" value={endpoint} spellCheck={false} invalid={Boolean(errors.endpoint && endpoint.trim())} onChange={(e) => setEndpoint(e.target.value)} className="font-mono text-xs" />
            </Field>
          </div>

          <ApiKeyBlock
            id="img-secret"
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

          <Field label="Model" htmlFor="img-model" error={err("model")} aside={<span className="text-2xs text-fg-faint">Needed before generating</span>}>
            <ModelPicker id="img-model" kind="image" providerId={current?.id ?? null} canFetch={canFetch} value={model} onChange={setModel} invalid={Boolean(err('model'))} />
          </Field>

          <div className="rounded-md border border-line bg-surface-1 px-3 py-2.5 text-xs">
            <p className="font-medium text-fg">
              {caps.family}
              {!caps.known && <span className="font-normal text-warning"> · not a documented OpenAI image model</span>}
            </p>
            <p className="mt-1 text-fg-subtle">
              Sizes: {caps.sizes.map((s) => SIZE_LABEL[s] ?? s).join(', ')} · Quality: {caps.qualities?.join(', ') ?? 'not selectable'} · Formats:{' '}
              {caps.formats?.map((f) => f.toUpperCase()).join(', ') ?? 'PNG only'} · Up to {caps.maxImages} per request ·{' '}
              {caps.reportsUsage ? 'reports token usage' : 'no usage reported'}
            </p>
            <p className="mt-1 text-2xs text-fg-faint">From OpenAI’s API reference for POST /images/generations. Unrecognised models get one square image and no optional parameters.</p>
          </div>

          <div className="grid grid-cols-2 gap-4 @2xl:grid-cols-5">
            <Field label="Default size" htmlFor="img-size" className="@2xl:col-span-2">
              <Select<string> id="img-size" value={size} onChange={setSize} options={caps.sizes.map((s) => ({ value: s, label: SIZE_LABEL[s] ?? s }))} />
            </Field>
            {caps.qualities && (
              <Field label="Default quality" htmlFor="img-quality">
                <Select<string> id="img-quality" value={quality} onChange={setQuality} options={caps.qualities.map((q) => ({ value: q, label: q }))} />
              </Field>
            )}
            {caps.formats && (
              <Field label="Default format" htmlFor="img-format" hint={format === 'png' ? 'PNG files are larger — X allows 5 MB.' : undefined}>
                <Select<ImageFormat> id="img-format" value={format} onChange={setFormat} options={caps.formats.map((f) => ({ value: f, label: f.toUpperCase() }))} />
              </Field>
            )}
            <Field label="Timeout (s)" htmlFor="img-timeout" error={err('timeout')}>
              <Input id="img-timeout" inputMode="numeric" value={timeoutSec} invalid={Boolean(err('timeout'))} onChange={(e) => setTimeoutSec(e.target.value)} />
            </Field>
          </div>
          <Field label="Retries for model listing" htmlFor="img-retries" error={err('retries')} hint="Image generation itself is never retried automatically — each attempt is billed." className="max-w-xs">
            <Input id="img-retries" inputMode="numeric" value={retries} invalid={Boolean(err('retries'))} onChange={(e) => setRetries(e.target.value)} />
          </Field>
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
          <section aria-label="Connection" className="mt-5 flex flex-col gap-2 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-fg">Connection</span>
              <StatusBadge tone={status.tone} dot>
                {status.label}
              </StatusBadge>
              {lastTest && <span className="text-xs text-fg-subtle">checked {formatRelative(lastTest.checkedAt)}{lastTest.ok && lastTest.latencyMs !== null ? ` · ${lastTest.latencyMs} ms` : ''}</span>}
              <span className="flex-1" />
              <a href={meta.docsUrl} onClick={(e) => (e.preventDefault(), void relay.shell.openExternal(meta.docsUrl))} className="flex items-center gap-1 rounded-xs text-xs text-fg-subtle hover:text-fg focus-ring">
                API reference <ExternalLink size={11} />
              </a>
              <Button size="sm" icon={PlugZap} loading={testing} disabled={!canFetch} onClick={runTest}>
                Test connection
              </Button>
            </div>
            {status.detail && <p className={cn('text-xs', status.tone === 'danger' ? 'text-danger' : status.tone === 'warning' ? 'text-warning' : 'text-fg-subtle')}>{status.detail}</p>}
            <p className="text-xs text-fg-faint">The test lists models with the saved key (GET /models) — free, no image is generated. Generate from the draft editor to verify image output.</p>
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
        onConfirm={async () => {
          if (current) {
            try {
              const updated = await relay.providers.removeKey(current.id)
              setCurrent(updated)
              onSaved(updated)
            } catch (error) {
              toast({ tone: 'danger', title: 'Could not remove key', description: errorMessage(error) })
            }
          }
          setConfirmRemoveKey(false)
        }}
      />
    </>
  )
}
