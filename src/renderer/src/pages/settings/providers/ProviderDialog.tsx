import { PlugZap, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { keyRequired, PROVIDER_KINDS, PROVIDER_KIND_LIST, validateEndpoint, validateModel, validateProviderName } from '@shared/config/providers'
import { DEFAULT_PROVIDER_SETTINGS, type ProviderConfig, type ProviderInput, type ProviderKind } from '@shared/types/providers'
import type { CredentialStatus } from '@shared/types/storage'
import { Button, ConfirmDialog, Field, Input, Modal, Notice, SecretInput, Select, Switch, Tooltip, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'
import { formatRelative } from '@/lib/format'
import { KIND_ICON } from './providerMeta'

interface ProviderDialogProps {
  open: boolean
  /** Existing configuration to edit, or null to create. */
  provider: ProviderConfig | null
  /** Lock the type (used by type-specific sections). */
  fixedKind?: ProviderKind
  credentials: CredentialStatus | undefined
  onClose: () => void
  onSaved: (provider: ProviderConfig) => void
}

type Touched = Partial<Record<'name' | 'endpoint' | 'model' | 'secret', boolean>>

export function ProviderDialog({ open, provider, fixedKind, credentials, onClose, onSaved }: ProviderDialogProps) {
  const toast = useToast()
  const [current, setCurrent] = useState<ProviderConfig | null>(provider)
  const [kind, setKind] = useState<ProviderKind>(fixedKind ?? 'ixbrowser')
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [timeoutSec, setTimeoutSec] = useState(String(DEFAULT_PROVIDER_SETTINGS.timeoutMs / 1000))
  const [retries, setRetries] = useState(String(DEFAULT_PROVIDER_SETTINGS.retries))
  const [testing, setTesting] = useState(false)
  const [secret, setSecret] = useState('')
  const [replacingKey, setReplacingKey] = useState(false)
  const [touched, setTouched] = useState<Touched>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false)

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (!open) return
    const initialKind = provider?.kind ?? fixedKind ?? 'ixbrowser'
    const meta = PROVIDER_KINDS[initialKind]
    setCurrent(provider)
    setKind(initialKind)
    setName(provider?.name ?? meta.defaultName)
    setEndpoint(provider?.endpoint ?? meta.defaultEndpoint)
    setModel(provider?.model ?? meta.modelSuggestions[0] ?? '')
    setEnabled(provider?.enabled ?? true)
    setTimeoutSec(String((provider?.settings.timeoutMs ?? DEFAULT_PROVIDER_SETTINGS.timeoutMs) / 1000))
    setRetries(String(provider?.settings.retries ?? DEFAULT_PROVIDER_SETTINGS.retries))
    setSecret('')
    setReplacingKey(false)
    setTouched({})
    setServerError(null)
  }, [open, provider, fixedKind])

  const meta = PROVIDER_KINDS[kind]
  const needsKey = keyRequired(kind, endpoint)
  const secure = credentials?.secure ?? false
  const credential = current?.credential ?? null
  const showKeyInput = secure && (!credential || !credential.present || replacingKey)

  const errors = {
    name: validateProviderName(name),
    endpoint: validateEndpoint(kind, endpoint),
    model: validateModel(kind, model || null),
    timeout: !/^\d+$/.test(timeoutSec) || Number(timeoutSec) < 1 || Number(timeoutSec) > 120 ? 'Use 1–120 seconds.' : null,
    retries: !/^\d$/.test(retries) || Number(retries) > 5 ? 'Use 0–5.' : null,
    secret: secret && secret.trim().length < 8 ? 'That key looks too short.' : /\s/.test(secret.trim()) ? 'Keys cannot contain spaces.' : null
  }
  const hasErrors = Object.values(errors).some(Boolean)

  const changeKind = (next: ProviderKind) => {
    const nextMeta = PROVIDER_KINDS[next]
    setKind(next)
    setName(nextMeta.defaultName)
    setEndpoint(nextMeta.defaultEndpoint)
    setModel(nextMeta.modelSuggestions[0] ?? '')
    setTouched({})
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched({ name: true, endpoint: true, model: true, secret: true })
    if (hasErrors) return
    setSaving(true)
    setServerError(null)
    const input: ProviderInput = {
      kind,
      name,
      endpoint,
      model: model.trim() || null,
      enabled,
      settings: { timeoutMs: Number(timeoutSec) * 1000, retries: Number(retries) }
    }
    let saved: ProviderConfig | null = null
    try {
      saved = current ? await relay.providers.update(current.id, input) : await relay.providers.create(input)
      setCurrent(saved)
      if (secret.trim()) {
        saved = await relay.providers.setKey(saved.id, secret.trim())
        setSecret('')
      }
      toast({
        tone: 'success',
        title: current ? 'Configuration updated' : 'Configuration added',
        description: secret.trim() ? 'The API key was encrypted and stored on this device.' : undefined
      })
      onSaved(saved)
      onClose()
    } catch (error) {
      // If the config saved but the key failed, keep the dialog open in edit mode.
      if (saved) onSaved(saved)
      setServerError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const testSaved = async () => {
    if (!current) return
    setTesting(true)
    setServerError(null)
    try {
      const result = await relay.ixbrowser.testConnection(current.id)
      if (result.ok) toast({ tone: 'success', title: 'Connected to IX Browser', description: `${result.totalProfiles} profiles · ${result.latencyMs} ms` })
      else setServerError(`${result.error?.message ?? 'Connection failed.'} ${result.error?.hint ?? ''}`)
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

  const err = (field: keyof Touched) => (touched[field] ? errors[field] : null)

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        dismissible={!saving}
        size="lg"
        title={current ? `Edit ${current.name}` : `Add ${fixedKind ? meta.label : 'provider'} configuration`}
        description={meta.description}
        footer={
          <>
            {kind === 'ixbrowser' ? (
              <Tooltip content={current ? 'Sends a real request using the saved settings' : 'Save the connection first'} className="mr-auto">
                <Button icon={PlugZap} disabled={!current || saving} loading={testing} onClick={testSaved}>
                  Test connection
                </Button>
              </Tooltip>
            ) : (
              <Tooltip content={`Connection tests arrive in Phase ${meta.testPhase}`} className="mr-auto">
                <Button icon={PlugZap} disabled>
                  Test connection
                </Button>
              </Tooltip>
            )}
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="provider-form" loading={saving}>
              {current ? 'Save changes' : 'Add configuration'}
            </Button>
          </>
        }
      >
        <form id="provider-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
          {serverError && (
            <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
              {serverError}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Field label="Type" htmlFor="provider-kind" hint={current ? 'The type cannot be changed after creation.' : undefined}>
              <Select<ProviderKind>
                id="provider-kind"
                value={kind}
                onChange={changeKind}
                disabled={Boolean(current || fixedKind)}
                // AI text and image providers have their own dialogs.
                options={PROVIDER_KIND_LIST.filter((k) => k.kind === 'ixbrowser').map((k) => ({ value: k.kind, label: k.label, icon: KIND_ICON[k.kind] }))}
              />
            </Field>
            <Field label="Name" htmlFor="provider-name" error={err('name')}>
              <Input
                id="provider-name"
                data-autofocus
                value={name}
                maxLength={60}
                spellCheck={false}
                invalid={Boolean(err('name'))}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, name: true }))}
              />
            </Field>
          </div>

          <Field
            label="Endpoint"
            htmlFor="provider-endpoint"
            error={err('endpoint')}
            hint={meta.loopbackOnly ? 'Runs on this computer — only 127.0.0.1 or localhost is accepted.' : 'Remote endpoints must use https://.'}
            aside={
              endpoint !== meta.defaultEndpoint && (
                <button type="button" onClick={() => setEndpoint(meta.defaultEndpoint)} className="rounded-xs text-xs text-accent-text hover:underline focus-ring">
                  Use default
                </button>
              )
            }
          >
            <Input
              id="provider-endpoint"
              value={endpoint}
              spellCheck={false}
              invalid={Boolean(err('endpoint'))}
              onChange={(e) => setEndpoint(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, endpoint: true }))}
              className="font-mono text-xs"
            />
          </Field>

          {(meta.requiresModel || meta.modelSuggestions.length > 0) && (
            <Field label="Model" htmlFor="provider-model" error={err('model')}>
              <Input
                id="provider-model"
                value={model}
                spellCheck={false}
                invalid={Boolean(err('model'))}
                onChange={(e) => setModel(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, model: true }))}
                className="font-mono text-xs"
              />
              <div className="flex flex-wrap gap-1.5">
                {meta.modelSuggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => setModel(suggestion)}
                    aria-pressed={model === suggestion}
                    className={
                      model === suggestion
                        ? 'h-6 rounded-sm border border-accent-line bg-accent-soft px-2 font-mono text-2xs text-accent-text focus-ring'
                        : 'h-6 rounded-sm border border-line-strong px-2 font-mono text-2xs text-fg-muted hover:border-line-heavy hover:text-fg focus-ring'
                    }
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {kind === 'ixbrowser' && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="Request timeout (seconds)" htmlFor="provider-timeout" error={errors.timeout}>
                <Input id="provider-timeout" inputMode="numeric" value={timeoutSec} invalid={Boolean(errors.timeout)} onChange={(e) => setTimeoutSec(e.target.value)} />
              </Field>
              <Field label="Retries for read requests" htmlFor="provider-retries" error={errors.retries} hint="Opening and closing profiles is never retried.">
                <Input id="provider-retries" inputMode="numeric" value={retries} invalid={Boolean(errors.retries)} onChange={(e) => setRetries(e.target.value)} />
              </Field>
            </div>
          )}

          {kind !== 'ixbrowser' && (
          <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-fg">API key</span>
              <span className="text-xs text-fg-subtle">{needsKey ? 'Required' : 'Optional'}</span>
            </div>

            {!secure ? (
              <Notice tone="warning" icon={ShieldAlert} title="Secure key storage is unavailable">
                {credentials?.detail ?? 'Checking credential storage…'} Keys cannot be saved until it is available — nothing is stored in plain text.
              </Notice>
            ) : credential && !replacingKey ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm tracking-wider text-fg-muted" aria-label="Stored key, masked">
                  ••••••••••••{credential.hint ?? '••••'}
                </span>
                {credential.present ? (
                  <span className="flex items-center gap-1 text-xs text-success">
                    <ShieldCheck size={12} strokeWidth={2} /> Encrypted · updated {formatRelative(credential.updatedAt)}
                  </span>
                ) : (
                  <span className="text-xs text-warning">Missing on this device — enter it again</span>
                )}
                <span className="flex-1" />
                <Button size="sm" onClick={() => setReplacingKey(true)}>
                  Replace key
                </Button>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirmRemoveKey(true)}>
                  Remove
                </Button>
              </div>
            ) : null}

            {showKeyInput && (
              <Field
                label={credential ? 'New key' : 'Key'}
                htmlFor="provider-secret"
                error={err('secret')}
                hint={
                  needsKey
                    ? 'Encrypted with your operating system and never shown again. You can also add it later.'
                    : meta.kind === 'ixbrowser'
                      ? 'IX Browser’s local API usually needs no key.'
                      : 'Local servers usually need no key. If yours does, it is encrypted like any other.'
                }
              >
                <SecretInput
                  id="provider-secret"
                  value={secret}
                  placeholder={needsKey ? 'Paste your API key' : 'Optional'}
                  invalid={Boolean(err('secret'))}
                  onChange={(e) => setSecret(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, secret: true }))}
                />
              </Field>
            )}
          </div>
          )}

          <label className="flex items-center justify-between gap-3">
            <span className="flex flex-col">
              <span className="text-sm text-fg">Enabled</span>
              <span className="text-xs text-fg-subtle">Disabled configurations are kept but never used.</span>
            </span>
            <Switch checked={enabled} onChange={setEnabled} aria-label="Enabled" />
          </label>
        </form>
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
