import { ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import type { Proxy, ProxyInput, ProxyScheme } from '@shared/types/proxies'
import { Button, Field, Input, Modal, SecretInput, SegmentedControl, Switch, Textarea, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'

interface ProxyDialogProps {
  open: boolean
  proxy: Proxy | null
  onClose: () => void
  onSaved: (proxy: Proxy) => void
}

const HOST = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}|[0-9a-fA-F:]{2,39})$/
const DEFAULT_PORT: Record<ProxyScheme, string> = { http: '8080', https: '443', socks5: '1080' }

/** Add or edit a proxy. The password is write-only: it is encrypted and never shown again. */
export function ProxyDialog({ open, proxy, onClose, onSaved }: ProxyDialogProps) {
  const toast = useToast()
  const [scheme, setScheme] = useState<ProxyScheme>('http')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('8080')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordMode, setPasswordMode] = useState<'keep' | 'replace' | 'remove'>('keep')
  const [label, setLabel] = useState('')
  const [notes, setNotes] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setScheme(proxy?.scheme ?? 'http')
    setHost(proxy?.host ?? '')
    setPort(String(proxy?.port ?? 8080))
    setUsername(proxy?.username ?? '')
    setPassword('')
    setPasswordMode(proxy?.hasPassword ? 'keep' : 'replace')
    setLabel(proxy?.label ?? '')
    setNotes(proxy?.notes ?? '')
    setEnabled(proxy?.enabled ?? true)
    setSubmitted(false)
    setServerError(null)
  }, [open, proxy])

  const portNumber = Number(port)
  const errors = {
    host: !host.trim() ? 'Enter the proxy’s host name or IP address.' : !HOST.test(host.trim()) ? 'That doesn’t look like a host name or IP address.' : null,
    port: !/^\d{1,5}$/.test(port) || portNumber < 1 || portNumber > 65535 ? 'Use a port between 1 and 65535.' : null,
    password: password.length > 255 ? 'Up to 255 characters.' : password && !username.trim() ? 'A password needs a username.' : null,
    label: label.length > 80 ? 'Up to 80 characters.' : null
  }
  const invalid = Object.values(errors).some(Boolean)

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    setSubmitted(true)
    if (invalid) return
    setSaving(true)
    setServerError(null)
    const input: ProxyInput = {
      label: label.trim(),
      scheme,
      host: host.trim(),
      port: portNumber,
      username: username.trim() || null,
      ...(passwordMode === 'remove' ? { password: null } : passwordMode === 'replace' && password ? { password } : {}),
      enabled,
      notes
    }
    try {
      const saved = proxy ? await relay.proxies.update(proxy.id, input) : await relay.proxies.create(input)
      toast({ tone: 'success', title: proxy ? 'Proxy updated' : 'Proxy added', description: 'Run a test to check it works.' })
      onSaved(saved)
    } catch (error) {
      setServerError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const err = (k: keyof typeof errors) => (submitted ? errors[k] : null)

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title={proxy ? `Edit ${proxy.label}` : 'Add proxy'}
      description="HTTP, HTTPS and SOCKS5 proxies, as IX Browser’s custom proxy mode supports them."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="proxy-form" loading={saving}>
            {proxy ? 'Save changes' : 'Add proxy'}
          </Button>
        </>
      }
    >
      <form id="proxy-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        {serverError && (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            {serverError}
          </div>
        )}
        <Field label="Type" htmlFor="proxy-scheme">
          <SegmentedControl<ProxyScheme>
            value={scheme}
            onChange={(next) => {
              if (port === DEFAULT_PORT[scheme]) setPort(DEFAULT_PORT[next])
              setScheme(next)
            }}
            options={[
              { value: 'http', label: 'HTTP' },
              { value: 'https', label: 'HTTPS' },
              { value: 'socks5', label: 'SOCKS5' }
            ]}
          />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
          <Field label="Host" htmlFor="proxy-host" error={err('host')}>
            <Input id="proxy-host" data-autofocus value={host} spellCheck={false} autoComplete="off" placeholder="proxy.example.com or 203.0.113.10" invalid={Boolean(err('host'))} onChange={(e) => setHost(e.target.value)} className="font-mono text-xs" />
          </Field>
          <Field label="Port" htmlFor="proxy-port" error={err('port')}>
            <Input id="proxy-port" inputMode="numeric" value={port} invalid={Boolean(err('port'))} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} className="font-mono text-xs" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Username" htmlFor="proxy-user" aside={<span className="text-2xs text-fg-faint">Optional</span>}>
            <Input id="proxy-user" value={username} spellCheck={false} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label="Password" htmlFor="proxy-pass" error={err('password')} aside={<span className="text-2xs text-fg-faint">Encrypted, never shown again</span>}>
            {proxy?.hasPassword && passwordMode === 'keep' ? (
              <div className="flex h-8 items-center gap-2">
                <span className="flex items-center gap-1 text-xs text-success">
                  <ShieldCheck size={12} /> Stored{proxy.passwordMissing ? ' (unreadable — enter it again)' : ''}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setPasswordMode('replace')}>
                  Replace
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPasswordMode('remove')}>
                  Remove
                </Button>
              </div>
            ) : passwordMode === 'remove' ? (
              <div className="flex h-8 items-center gap-2 text-xs text-warning">
                Will be removed on save
                <Button size="sm" variant="ghost" onClick={() => setPasswordMode('keep')}>
                  Undo
                </Button>
              </div>
            ) : (
              <SecretInput id="proxy-pass" value={password} invalid={Boolean(err('password'))} onChange={(e) => setPassword(e.target.value)} placeholder="Optional" />
            )}
          </Field>
        </div>
        <Field label="Label" htmlFor="proxy-label" error={err('label')} hint="Shown in lists. Defaults to the address.">
          <Input id="proxy-label" value={label} maxLength={90} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Notes" htmlFor="proxy-notes">
          <Textarea id="proxy-notes" rows={2} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} placeholder="Provider, region, renewal date…" />
        </Field>
        <label className="flex items-center justify-between gap-3">
          <span className="flex flex-col">
            <span className="text-sm text-fg">Enabled</span>
            <span className="text-xs text-fg-subtle">Disabled proxies can’t be assigned to profiles.</span>
          </span>
          <Switch checked={enabled} onChange={setEnabled} aria-label="Enabled" />
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
