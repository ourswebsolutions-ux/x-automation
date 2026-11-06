import { useState } from 'react'
import { Button, Field, Input, SettingsSection, useToast } from '@/components/ui'
import { errorMessage, relay } from '@/lib/bridge'

const PIN_FORMAT = /^\d{4}$/

function PinField({ id, label, value, onChange, error }: { id: string; label: string; value: string; onChange: (value: string) => void; error?: string | null }) {
  return (
    <Field label={label} htmlFor={id} error={error}>
      <Input id={id} type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={value} onChange={(event) => onChange(event.target.value.replace(/\D/g, ''))} />
    </Field>
  )
}

/** Settings → Security & app info. Works with or without a subscription. */
export function PinSection() {
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mismatch = confirm.length === 4 && next !== confirm

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const { ok, status } = await relay.pin.change(current, next)
      if (ok) {
        setCurrent('')
        setNext('')
        setConfirm('')
        toast({ tone: 'success', title: 'PIN changed' })
      } else {
        setError(status.retryAt ? 'Too many wrong attempts. Wait a moment, then try again.' : 'The current PIN is not correct.')
      }
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection title="App PIN" description="The 4-digit PIN that X Auto asks for each time it opens.">
      <form
        className="flex flex-col gap-3 px-4 py-3.5"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-3">
          <PinField id="pin-current" label="Current PIN" value={current} onChange={setCurrent} error={error} />
          <PinField id="pin-next" label="New PIN" value={next} onChange={setNext} />
          <PinField id="pin-confirm" label="Confirm new PIN" value={confirm} onChange={setConfirm} error={mismatch ? 'The PINs don’t match.' : null} />
        </div>
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={!PIN_FORMAT.test(current) || !PIN_FORMAT.test(next) || next !== confirm}>
            Change PIN
          </Button>
        </div>
      </form>
    </SettingsSection>
  )
}
