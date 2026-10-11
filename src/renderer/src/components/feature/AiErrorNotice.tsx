import { CircleAlert, Settings2 } from 'lucide-react'
import { useNavigate } from 'react-router'
import type { AiError } from '@shared/types/ai'
import { Button } from '@/components/ui'
import { settingsPath } from '@/app/navigation'
import { ERROR_KIND } from '@/pages/settings/ai/aiMeta'

const SETTINGS_KINDS = new Set(['not-configured', 'auth', 'quota', 'model', 'blocked-endpoint', 'invalid-request'])

/** A failed AI request, explained — with a way to the settings when that is where the fix is. */
export function AiErrorNotice({ error, onRetry }: { error: Pick<AiError, 'kind' | 'message' | 'hint'>; onRetry?: () => void }) {
  const navigate = useNavigate()
  return (
    <div role="alert" className="flex gap-2.5 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-3 text-sm animate-fade-in">
      <CircleAlert size={15} className="mt-0.5 shrink-0 text-danger" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-danger">
          {ERROR_KIND[error.kind]} — {error.message}
        </span>
        {error.hint && <span className="text-xs text-fg-muted">{error.hint}</span>}
        <span className="flex gap-2 pt-1">
          {onRetry && error.kind !== 'not-configured' && (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
          {SETTINGS_KINDS.has(error.kind) && (
            <Button size="sm" variant="ghost" icon={Settings2} onClick={() => navigate(settingsPath('ai'))}>
              AI provider settings
            </Button>
          )}
        </span>
      </div>
    </div>
  )
}
