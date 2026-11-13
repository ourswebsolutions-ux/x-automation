import { CalendarClock, ClipboardCopy, Copy, KeyRound, RefreshCw, Send, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { PLAN_NAMES, type PlanId, type SubscriptionPlan, type SubscriptionState } from '@shared/types/security'
import { Button, ErrorState, Field, Input, Notice, SettingsRow, SettingsSection, Skeleton, StatusBadge, Textarea, useToast, type Tone } from '@/components/ui'
import { useAsync } from '@/hooks/useAsync'
import { errorMessage, relay } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatDateTime } from '@/lib/format'
import { useSubscription } from '@/state/subscription'

const STATE: Record<SubscriptionState, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'success' },
  none: { label: 'Not activated', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'warning' },
  revoked: { label: 'Revoked', tone: 'danger' },
  stale: { label: 'Needs checking', tone: 'warning' }
}

const RESEND_AFTER_MS = 60_000

function useSecondsUntil(iso: string | null): number {
  const left = () => (iso ? Math.max(Math.ceil((new Date(iso).getTime() - Date.now()) / 1000), 0) : 0)
  const [seconds, setSeconds] = useState(left)
  useEffect(() => {
    setSeconds(left())
    if (!iso) return
    const timer = setInterval(() => setSeconds(left()), 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iso])
  return seconds
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

function PlanCard({ plan, selected, onSelect }: { plan: SubscriptionPlan; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex flex-col gap-1 rounded-md border p-3 text-left transition-colors focus-ring',
        selected ? 'border-accent-line bg-accent-soft' : 'border-line-strong bg-surface-1 hover:border-line-heavy'
      )}
    >
      <span className="text-sm font-medium text-fg">{plan.name}</span>
      <span className="tabular text-base text-fg">
        {plan.currency} {plan.price}
      </span>
      <span className="text-xs text-fg-subtle">{plan.durationLabel}</span>
    </button>
  )
}

function CodeEntry({ plan, expiresAt, onResend }: { plan: PlanId; expiresAt: string; onResend: () => Promise<void> }) {
  const { setPending, setStatus } = useSubscription()
  const toast = useToast()
  const [otp, setOtp] = useState('')
  const [busy, setBusy] = useState(false)
  const [resending, setResending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seconds = useSecondsUntil(expiresAt)
  const canResend = useSecondsUntil(new Date(new Date(expiresAt).getTime() - 600_000 + RESEND_AFTER_MS).toISOString()) === 0

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const status = await relay.subscription.verifyOtp(plan, otp)
      setStatus(status)
      setPending(null)
      toast({ tone: 'success', title: 'Subscription activated', description: `${PLAN_NAMES[plan]} is active on this device.` })
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-3 px-4 py-3.5"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Notice tone="accent" icon={Send} title="Your request was sent to the administrator">
        Send your Activation ID, plan and payment to the administrator. After checking the payment they’ll give you a 6-digit code by WhatsApp or phone. It isn’t sent to your email.
      </Notice>
      <Field
        label={`Activation code for ${PLAN_NAMES[plan]}`}
        htmlFor="activation-code"
        error={error}
        hint={seconds > 0 ? `Expires in ${clock(seconds)}` : 'This code has expired. Request a new one.'}
      >
        <Input
          id="activation-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          className="tabular tracking-[0.3em]"
          value={otp}
          invalid={Boolean(error)}
          onChange={(event) => setOtp(event.target.value.replace(/\D/g, ''))}
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" loading={busy} disabled={otp.length !== 6 || seconds === 0}>
          Activate subscription
        </Button>
        <Button
          variant="ghost"
          loading={resending}
          disabled={!canResend}
          onClick={() => {
            setResending(true)
            setOtp('')
            setError(null)
            void onResend().finally(() => setResending(false))
          }}
        >
          Request a new code
        </Button>
        <Button variant="ghost" onClick={() => setPending(null)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function Activate() {
  const { pending, setPending, status } = useSubscription()
  const plans = useAsync(() => relay.subscription.plans(), [])
  const toast = useToast()
  const [selected, setSelected] = useState<PlanId | null>(null)
  const [busy, setBusy] = useState(false)

  const request = async (plan: PlanId) => {
    setBusy(true)
    try {
      const { expiresAt } = await relay.subscription.requestOtp(plan)
      setPending({ plan, expiresAt })
    } catch (failure) {
      toast({ tone: 'danger', title: 'The request wasn’t sent', description: errorMessage(failure) })
    } finally {
      setBusy(false)
    }
  }

  const isLifetime = status?.state === 'active' && status.plan === 'lifetime'
  if (isLifetime || status?.state === 'revoked') return null

  return (
    <SettingsSection
      title={status?.state === 'active' ? 'Renew or change plan' : 'Activate X Auto'}
      description={status?.state === 'active' ? 'Renewing adds to the time you have left.' : 'Choose a plan, then request an activation code.'}
    >
      {pending ? (
        <CodeEntry plan={pending.plan} expiresAt={pending.expiresAt} onResend={() => request(pending.plan)} />
      ) : plans.status === 'error' ? (
        <ErrorState size="sm" title="Plans could not be loaded" error={plans.error} onRetry={plans.reload} />
      ) : !plans.data ? (
        <div className="grid grid-cols-3 gap-3 p-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : plans.data.length === 0 ? (
        <div className="px-4 py-3.5 text-sm text-fg-subtle">No plans are available yet. Contact the administrator.</div>
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3.5">
          <div role="radiogroup" aria-label="Subscription plan" className="grid grid-cols-1 gap-3 @2xl:grid-cols-3">
            {plans.data.map((plan) => (
              <PlanCard key={plan.id} plan={plan} selected={selected === plan.id} onSelect={() => setSelected(plan.id)} />
            ))}
          </div>
          <div>
            <Button variant="primary" icon={ShieldCheck} loading={busy} disabled={!selected} onClick={() => selected && void request(selected)}>
              Activate
            </Button>
          </div>
        </div>
      )}
    </SettingsSection>
  )
}

const PLAN_LENGTHS: Record<PlanId, string> = { monthly: 'Monthly', six_months: '6 months', lifetime: 'Never expires' }

/** No activation server: the customer asks the administrator for a code, by any channel. */
function RequestCode({ activationId }: { activationId: string }) {
  const toast = useToast()
  const [selected, setSelected] = useState<PlanId | null>(null)
  const copy = () => {
    if (!selected) return
    const text = `X Auto activation request\nActivation ID: ${activationId}\nPlan: ${PLAN_NAMES[selected]}`
    void navigator.clipboard.writeText(text).then(
      () => toast({ tone: 'success', title: 'Request copied', description: 'Send it to the administrator by WhatsApp or email.' }),
      () => toast({ tone: 'danger', title: 'Could not copy', description: 'Send the administrator your Activation ID and plan by hand.' })
    )
  }
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div role="radiogroup" aria-label="Subscription plan" className="grid grid-cols-1 gap-3 @2xl:grid-cols-3">
        {(Object.keys(PLAN_NAMES) as PlanId[]).map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected === id}
            onClick={() => setSelected(id)}
            className={cn(
              'flex flex-col gap-1 rounded-md border p-3 text-left transition-colors focus-ring',
              selected === id ? 'border-accent-line bg-accent-soft' : 'border-line-strong bg-surface-1 hover:border-line-heavy'
            )}
          >
            <span className="text-sm font-medium text-fg">{PLAN_NAMES[id]}</span>
            <span className="text-xs text-fg-subtle">{PLAN_LENGTHS[id]}</span>
          </button>
        ))}
      </div>
      <div>
        <Button variant="primary" icon={ClipboardCopy} disabled={!selected} onClick={copy}>
          Copy request
        </Button>
      </div>
    </div>
  )
}

/** Where the administrator's code goes. Works with or without an activation server. */
function EnterCode() {
  const { setStatus } = useSubscription()
  const toast = useToast()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const status = await relay.subscription.applyCode(code)
      setStatus(status)
      setCode('')
      toast({ tone: 'success', title: 'Subscription activated', description: status.plan ? `${PLAN_NAMES[status.plan]} is active on this device.` : undefined })
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsSection title="Enter activation code" description="Paste the code the administrator sent you after payment.">
      <form
        className="flex flex-col gap-3 px-4 py-3.5"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Field label="Activation code" htmlFor="activation-token" error={error}>
          <Textarea
            id="activation-token"
            rows={3}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs break-all"
            value={code}
            invalid={Boolean(error)}
            onChange={(event) => setCode(event.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={code.trim().length < 20}>
            Activate with code
          </Button>
        </div>
      </form>
    </SettingsSection>
  )
}

/** Settings → Subscription. Plans and prices come from the activation server when there is one. */
export function SubscriptionSection() {
  const { status, setStatus } = useSubscription()
  const toast = useToast()
  const [checking, setChecking] = useState(false)

  const check = async () => {
    setChecking(true)
    try {
      setStatus(await relay.subscription.refresh())
    } catch (failure) {
      toast({ tone: 'danger', title: 'Could not check', description: errorMessage(failure) })
    } finally {
      setChecking(false)
    }
  }

  const copy = () => {
    if (!status) return
    void navigator.clipboard.writeText(status.activationId).then(
      () => toast({ tone: 'success', title: 'Activation ID copied' }),
      () => toast({ tone: 'danger', title: 'Could not copy', description: 'Select the Activation ID and copy it by hand.' })
    )
  }

  if (!status) {
    return (
      <SettingsSection title="Subscription">
        <div className="p-4">
          <Skeleton className="h-4 w-40" />
        </div>
      </SettingsSection>
    )
  }

  const state = STATE[status.state]
  return (
    <>
      <SettingsSection
        title="Subscription"
        description="Your plan on this device."
        meta={
          <StatusBadge tone={state.tone} dot>
            {state.label}
          </StatusBadge>
        }
      >
        <SettingsRow
          label="Activation ID"
          description="Unique to this device. Give it to the administrator when you pay."
          control={
            <div className="flex items-center gap-2">
              <code data-testid="activation-id" className="select-text font-mono text-sm text-fg">
                {status.activationId}
              </code>
              <Button size="sm" variant="ghost" icon={Copy} onClick={copy}>
                Copy
              </Button>
            </div>
          }
        />
        {status.plan && <SettingsRow label="Plan" control={<span className="text-sm text-fg">{PLAN_NAMES[status.plan]}</span>} />}
        {status.plan && (
          <SettingsRow
            label={status.state === 'expired' ? 'Expired' : 'Expires'}
            control={
              <span className="flex items-center gap-1.5 text-sm text-fg">
                <CalendarClock size={13} className="text-fg-subtle" aria-hidden />
                {status.expiresAt ? formatDateTime(status.expiresAt) : 'Never'}
              </span>
            }
          />
        )}
        {status.serviceConfigured && (
          <SettingsRow
            label="Last checked"
            description={status.lastCheckedAt ? formatDateTime(status.lastCheckedAt) : 'Not yet checked with the activation service.'}
            control={
              <Button size="sm" icon={RefreshCw} loading={checking} onClick={() => void check()}>
                Check now
              </Button>
            }
          />
        )}
      </SettingsSection>
      {status.state === 'revoked' && (
        <Notice tone="warning" title="This subscription was revoked">
          Contact the administrator to restore it.
        </Notice>
      )}
      {status.serviceConfigured ? (
        <Activate />
      ) : (
        !(status.state === 'active' && status.plan === 'lifetime') &&
        status.state !== 'revoked' && (
          <SettingsSection
            title={status.state === 'active' ? 'Renew or change plan' : 'Activate X Auto'}
            description="Choose a plan and send the request to the administrator. After payment they’ll send you an activation code."
          >
            <RequestCode activationId={status.activationId} />
          </SettingsSection>
        )
      )}
      {status.state !== 'revoked' && !(status.state === 'active' && status.plan === 'lifetime') && <EnterCode />}
    </>
  )
}
