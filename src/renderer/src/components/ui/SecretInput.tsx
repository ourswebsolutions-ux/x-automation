import { Eye, EyeOff, KeyRound } from 'lucide-react'
import { useState, type ComponentPropsWithRef } from 'react'
import { Input } from './Input'

type SecretInputProps = Omit<ComponentPropsWithRef<typeof Input>, 'type' | 'icon' | 'trailing'>

/**
 * Write-only secret entry. Never pre-filled from stored values; browser
 * autofill, spellcheck and autocorrect are off. Reveal only shows what the
 * user is typing right now.
 */
export function SecretInput(props: SecretInputProps) {
  const [visible, setVisible] = useState(false)
  return (
    <Input
      {...props}
      type={visible ? 'text' : 'password'}
      icon={KeyRound}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      className="font-mono text-xs"
      trailing={
        <button
          type="button"
          aria-label={visible ? 'Hide key' : 'Show key'}
          onClick={() => setVisible((v) => !v)}
          disabled={props.disabled}
          className="-mr-1 grid size-6 place-items-center rounded-xs text-fg-subtle hover:bg-neutral-soft hover:text-fg focus-ring disabled:opacity-40"
        >
          {visible ? <EyeOff size={13} strokeWidth={1.8} /> : <Eye size={13} strokeWidth={1.8} />}
        </button>
      }
    />
  )
}
