import { CircleAlert, Send, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { TEST_PROMPT_MAX_CHARS, TEST_PROMPT_MAX_OUTPUT_TOKENS } from '@shared/config/aiAdapters'
import type { TestPromptOutcome } from '@shared/types/ai'
import { Button, StatusBadge, Textarea } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'
import { formatNumber } from '@/lib/format'
import { ERROR_KIND } from './aiMeta'

const FINISH: Record<string, string> = { stop: 'Finished', length: 'Stopped at the output limit', 'content-filter': 'Stopped by a content filter', other: 'Stopped' }

/** Sends one short, real (billed) request through the AI service and shows exactly what came back. */
export function TryPrompt({ providerId, disabledReason }: { providerId: string; disabledReason: string | null }) {
  const [prompt, setPrompt] = useState('Reply with one short sentence confirming you received this message.')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<TestPromptOutcome | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const live = useRef(true)
  useEffect(() => () => void (live.current = false), [])

  const send = async () => {
    const id = crypto.randomUUID()
    setRequestId(id)
    setOutcome(null)
    setFailure(null)
    try {
      const result = await relay.ai.testPrompt({ providerId, requestId: id, prompt })
      if (live.current) setOutcome(result)
    } catch (error) {
      if (live.current) setFailure(errorMessage(error))
    } finally {
      if (live.current) setRequestId(null)
    }
  }

  const running = requestId !== null
  const tooLong = prompt.length > TEST_PROMPT_MAX_CHARS

  return (
    <div className="flex flex-col gap-2.5">
      <Textarea
        aria-label="Test prompt"
        rows={2}
        value={prompt}
        invalid={tooLong}
        disabled={running}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <Button icon={Square} onClick={() => requestId && void relay.ai.cancel(requestId)}>
            Cancel request
          </Button>
        ) : (
          <Button icon={Send} disabled={Boolean(disabledReason) || !prompt.trim() || tooLong} onClick={send}>
            Send test prompt
          </Button>
        )}
        <span className="text-xs text-fg-subtle">
          {disabledReason ?? `A real request, billed by the provider. Output is capped at ${TEST_PROMPT_MAX_OUTPUT_TOKENS} tokens.`}
        </span>
        <span className={tooLong ? 'ml-auto text-2xs text-danger' : 'ml-auto text-2xs text-fg-faint'}>
          {prompt.length}/{TEST_PROMPT_MAX_CHARS}
        </span>
      </div>

      {running && <p className="text-xs text-fg-muted">Waiting for the provider…</p>}
      {failure && <p className="text-xs text-danger">{failure}</p>}
      {outcome?.ok === false && (
        <div role="alert" className="flex gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm">
          <CircleAlert size={14} className="mt-0.5 shrink-0 text-danger" />
          <div className="flex flex-col gap-0.5">
            <span className="text-danger">
              {ERROR_KIND[outcome.error.kind]} — {outcome.error.message}
            </span>
            {outcome.error.hint && <span className="text-xs text-fg-muted">{outcome.error.hint}</span>}
          </div>
        </div>
      )}
      {outcome?.ok && (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-1 px-3 py-2.5">
          <p data-selectable className="whitespace-pre-wrap break-words text-sm text-fg">
            {outcome.result.text || <span className="text-fg-subtle">(The provider returned no text.)</span>}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-subtle">
            <StatusBadge tone={outcome.result.finishReason === 'stop' ? 'success' : 'warning'}>{FINISH[outcome.result.finishReason]}</StatusBadge>
            <span className="font-mono">{outcome.result.model}</span>
            <span>{formatNumber(outcome.result.latencyMs)} ms</span>
            <span>
              {outcome.result.usage
                ? `${outcome.result.usage.inputTokens ?? '—'} in · ${outcome.result.usage.outputTokens ?? '—'} out tokens (reported by the provider)`
                : 'No token usage reported by the provider'}
            </span>
            {outcome.result.providerRequestId && <span className="font-mono text-fg-faint">{outcome.result.providerRequestId}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
