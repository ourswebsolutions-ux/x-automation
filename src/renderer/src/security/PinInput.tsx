import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { cn } from '@/lib/cn'

const LENGTH = 4

interface PinInputProps {
  /** Changing this clears the boxes and returns focus to the first. */
  resetKey: number
  disabled?: boolean
  invalid?: boolean
  label: string
  onComplete: (pin: string) => void
}

/** Four masked digit boxes. Submits on the fourth digit. */
export function PinInput({ resetKey, disabled, invalid, label, onComplete }: PinInputProps) {
  const [digits, setDigits] = useState(() => Array<string>(LENGTH).fill(''))
  const boxes = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    setDigits(Array<string>(LENGTH).fill(''))
    boxes.current[0]?.focus()
  }, [resetKey])

  useEffect(() => {
    if (!disabled) boxes.current[0]?.focus()
  }, [disabled])

  const commit = (next: string[]) => {
    setDigits(next)
    if (next.every(Boolean)) onComplete(next.join(''))
  }

  const type = (index: number, value: string) => {
    const digit = value.replace(/\D/g, '').slice(-1)
    if (!digit) return
    const next = [...digits]
    next[index] = digit
    commit(next)
    boxes.current[Math.min(index + 1, LENGTH - 1)]?.focus()
  }

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      event.preventDefault()
      const next = [...digits]
      const target = digits[index] ? index : Math.max(index - 1, 0)
      next[target] = ''
      setDigits(next)
      boxes.current[target]?.focus()
    } else if (event.key === 'ArrowLeft') boxes.current[Math.max(index - 1, 0)]?.focus()
    else if (event.key === 'ArrowRight') boxes.current[Math.min(index + 1, LENGTH - 1)]?.focus()
  }

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault()
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, LENGTH).split('')
    if (!pasted.length) return
    commit(Array.from({ length: LENGTH }, (_, i) => pasted[i] ?? ''))
    boxes.current[Math.min(pasted.length, LENGTH - 1)]?.focus()
  }

  return (
    <div role="group" aria-label={label} className="flex justify-center gap-2.5">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(element) => {
            boxes.current[index] = element
          }}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-label={`Digit ${index + 1} of ${LENGTH}`}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          value={digit}
          onChange={(event) => type(index, event.target.value)}
          onKeyDown={(event) => onKeyDown(index, event)}
          onPaste={onPaste}
          onFocus={(event) => event.target.select()}
          className={cn(
            'size-12 rounded-md border bg-surface-1 text-center text-lg text-fg outline-none transition-[border-color,box-shadow] duration-150',
            'focus:border-accent-line focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-50',
            invalid ? 'border-danger/60' : 'border-line-strong'
          )}
        />
      ))}
    </div>
  )
}
