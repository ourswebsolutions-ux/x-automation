import { Copy, KeyRound } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { PinStatus } from '@shared/types/security'
import { Button, Checkbox, ErrorState, Field, Input, useToast } from '@/components/ui'
import { useAsync } from '@/hooks/useAsync'
import { BrandMark } from '@/layout/BrandMark'
import { WindowControls } from '@/layout/WindowControls'
import { errorMessage, relay } from '@/lib/bridge'
import { PinInput } from './PinInput'

const PIN_FORMAT = /^\d{4}$/

function Frame({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="drag flex h-11 shrink-0 items-center justify-end">{relay.app.platform !== 'darwin' && <WindowControls />}</header>
      <main className="grid min-h-0 flex-1 place-items-center overflow-y-auto px-6 pb-16">
        <div className="flex w-full max-w-sm flex-col gap-5 rounded-lg border border-line bg-surface-2 p-6 shadow-raised animate-rise">
          <div className="flex flex-col items-center gap-2 text-center">
            <BrandMark size={32} />
            <h1 className="text-base font-medium text-fg">{title}</h1>
            <p className="text-sm text-fg-subtle text-pretty">{description}</p>
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}

function RecoveryCode({ code, onDone }: { code: string; onDone: () => void }) {
  const toast = useToast()
  const [saved, setSaved] = useState(false)
  return (
    <Frame title="Save your recovery code" description="If you forget your PIN, this code is the only way back in. It is shown once and can’t be recovered.">
      <div className="flex items-center justify-between gap-2 rounded-md border border-line-strong bg-surface-1 px-3 py-2.5">
        <code data-testid="recovery-code" className="select-text font-mono text-sm tracking-wide text-fg">
          {code}
        </code>
        <Button size="sm" variant="ghost" icon={Copy} onClick={() => void navigator.clipboard.writeText(code).then(() => toast({ tone: 'success', title: 'Copied' }), () => toast({ tone: 'danger', title: 'Could not copy', description: 'Write the code down instead.' }))}>
          Copy
        </Button>
      </div>
      <label className="flex items-center gap-2 text-sm text-fg-muted">
        <Checkbox checked={saved} onChange={setSaved} />
        I have saved this code somewhere safe
      </label>
      <Button variant="primary" disabled={!saved} onClick={onDone}>
        Continue
      </Button>
    </Frame>
  )
}

function SetupPin({ onDone }: { onDone: (status: PinStatus, recoveryCode: string) => void }) {
  const [first, setFirst] = useState<string | null>(null)
  const [mismatch, setMismatch] = useState(false)
  const [reset, setReset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const complete = async (pin: string) => {
    if (first === null) {
      setFirst(pin)
      setMismatch(false)
      setReset((n) => n + 1)
      return
    }
    if (pin !== first) {
      setFirst(null)
      setMismatch(true)
      setReset((n) => n + 1)
      return
    }
    setBusy(true)
    try {
      const result = await relay.pin.setup(pin)
      onDone(result.status, result.recoveryCode)
    } catch (failure) {
      setError(errorMessage(failure))
      setFirst(null)
      setReset((n) => n + 1)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Frame title={first === null ? 'Create a PIN' : 'Confirm your PIN'} description="X Auto asks for this 4-digit PIN each time it opens.">
      <PinInput label={first === null ? 'New PIN' : 'Confirm PIN'} resetKey={reset} disabled={busy} invalid={mismatch} onComplete={(pin) => void complete(pin)} />
      {(mismatch || error) && (
        <p role="alert" className="text-center text-xs text-danger">
          {error ?? 'The PINs didn’t match. Start again.'}
        </p>
      )}
    </Frame>
  )
}

function useCountdown(until: string | null, onEnd: () => void): number {
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (!until) return setLeft(0)
    const update = () => {
      const seconds = Math.ceil((new Date(until).getTime() - Date.now()) / 1000)
      setLeft(Math.max(seconds, 0))
      if (seconds <= 0) {
        clearInterval(timer)
        onEnd()
      }
    }
    const timer = setInterval(update, 1000)
    update()
    return () => clearInterval(timer)
    // onEnd only reloads status; restarting on its identity would only reset the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [until])
  return left
}

function UnlockPin({ status, onChange, onRecovered }: { status: PinStatus; onChange: (status: PinStatus) => void; onRecovered: (status: PinStatus, recoveryCode: string) => void }) {
  const [reset, setReset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [wrong, setWrong] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const secondsLeft = useCountdown(status.retryAt, () => void relay.pin.status().then(onChange))
  const lockedOut = secondsLeft > 0

  const submit = async (pin: string) => {
    setBusy(true)
    try {
      const result = await relay.pin.verify(pin)
      setWrong(!result.ok)
      onChange(result.status)
    } catch {
      setWrong(true)
    } finally {
      setBusy(false)
      setReset((n) => n + 1)
    }
  }

  if (recovering) return <RecoverPin onCancel={() => setRecovering(false)} onDone={onRecovered} onLockout={() => void relay.pin.status().then(onChange)} />

  return (
    <Frame title="Enter your PIN" description="Enter your 4-digit PIN to open X Auto.">
      <PinInput label="PIN" resetKey={reset} disabled={busy || lockedOut} invalid={wrong} onComplete={(pin) => void submit(pin)} />
      <div className="flex flex-col items-center gap-1 text-center">
        {lockedOut ? (
          <p role="alert" className="text-xs text-danger">
            Too many wrong attempts. Try again in {secondsLeft} second{secondsLeft === 1 ? '' : 's'}.
          </p>
        ) : (
          wrong && (
            <p role="alert" className="text-xs text-danger">
              Wrong PIN. {status.attemptsLeft} attempt{status.attemptsLeft === 1 ? '' : 's'} left before a pause.
            </p>
          )
        )}
        <Button size="sm" variant="ghost" onClick={() => setRecovering(true)}>
          Forgot your PIN?
        </Button>
      </div>
    </Frame>
  )
}

function RecoverPin({ onCancel, onDone, onLockout }: { onCancel: () => void; onDone: (status: PinStatus, recoveryCode: string) => void; onLockout: () => void }) {
  const [code, setCode] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await relay.pin.recover(code, pin)
      onDone(result.status, result.recoveryCode)
    } catch (failure) {
      setError(errorMessage(failure))
      onLockout()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Frame title="Reset your PIN" description="Enter the recovery code you saved when you created your PIN.">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Field label="Recovery code" htmlFor="recovery-code">
          <Input id="recovery-code" icon={KeyRound} autoFocus autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX" value={code} onChange={(event) => setCode(event.target.value)} />
        </Field>
        <Field label="New PIN" htmlFor="recovery-pin" error={error}>
          <Input id="recovery-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))} />
        </Field>
        <div className="flex justify-between">
          <Button variant="ghost" onClick={onCancel}>
            Back
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!code.trim() || !PIN_FORMAT.test(pin)}>
            Reset PIN
          </Button>
        </div>
      </form>
    </Frame>
  )
}

/**
 * Nothing behind this renders until the PIN passes, so pages make no calls the main process would
 * refuse. The main process remains the real barrier; this is what the user sees of it.
 */
export function SecurityGate({ children }: { children: ReactNode }) {
  const initial = useAsync(() => relay.pin.status(), [])
  const [status, setStatus] = useState<PinStatus | null>(null)
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null)
  const pin = status ?? initial.data

  if (initial.status === 'error') {
    return (
      <div className="grid h-full place-items-center bg-canvas">
        <ErrorState title="X Auto could not start" error={initial.error} onRetry={initial.reload} />
      </div>
    )
  }
  if (!pin) return null

  const finish = (next: PinStatus, code: string) => {
    setStatus(next)
    setRecoveryCode(code)
  }

  if (recoveryCode) return <RecoveryCode code={recoveryCode} onDone={() => setRecoveryCode(null)} />
  if (!pin.configured) return <SetupPin onDone={finish} />
  if (!pin.unlocked) return <UnlockPin status={pin} onChange={setStatus} onRecovered={finish} />
  return <>{children}</>
}

