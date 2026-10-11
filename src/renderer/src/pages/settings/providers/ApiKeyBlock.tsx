import { ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react'
import type { CredentialSummary } from '@shared/types/providers'
import type { CredentialStatus } from '@shared/types/storage'
import { Button, Field, Notice, SecretInput } from '@/components/ui'
import { formatRelative } from '@/lib/format'

interface ApiKeyBlockProps {
  id: string
  credential: CredentialSummary | null
  credentials: CredentialStatus | undefined
  needsKey: boolean
  secret: string
  onSecret: (value: string) => void
  replacing: boolean
  onReplace: () => void
  onRemove: () => void
  error: string | null
}

/** Write-only API key entry: shows only a masked hint once stored. */
export function ApiKeyBlock(props: ApiKeyBlockProps) {
  const secure = props.credentials?.secure ?? false
  const credential = props.credential
  const showInput = secure && (!credential || !credential.present || props.replacing)
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-fg">API key</span>
        <span className="text-xs text-fg-subtle">{props.needsKey ? 'Required' : 'Optional for local servers'}</span>
      </div>
      {!secure ? (
        <Notice tone="warning" icon={ShieldAlert} title="Secure key storage is unavailable">
          {props.credentials?.detail ?? 'Checking credential storage…'} Keys cannot be saved until it is available — nothing is stored in plain text.
        </Notice>
      ) : credential && !props.replacing ? (
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
          <Button size="sm" onClick={props.onReplace}>
            Replace key
          </Button>
          <Button size="sm" variant="ghost" icon={Trash2} onClick={props.onRemove}>
            Remove
          </Button>
        </div>
      ) : null}
      {showInput && (
        <Field label={credential ? 'New key' : 'Key'} htmlFor={props.id} error={props.error} hint="Encrypted by your operating system. It is never shown again or sent back to this window.">
          <SecretInput id={props.id} value={props.secret} placeholder={props.needsKey ? 'Paste your API key' : 'Optional'} invalid={Boolean(props.error)} onChange={(e) => props.onSecret(e.target.value)} />
        </Field>
      )}
    </div>
  )
}
