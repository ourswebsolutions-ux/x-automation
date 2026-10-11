import { KeyCombo, Modal } from '@/components/ui'
import { MOD_LABEL } from '@/hooks/useHotkey'
import { useUi } from '@/state/ui'

const GROUPS: { title: string; items: [string, string[]][] }[] = [
  {
    title: 'General',
    items: [
      ['Search and commands', [MOD_LABEL, 'K']],
      ['New draft', [MOD_LABEL, 'N']],
      ['Open settings', [MOD_LABEL, ',']],
      ['Toggle sidebar', [MOD_LABEL, 'B']],
      ['Show shortcuts', ['?']]
    ]
  },
  {
    title: 'Navigation',
    items: [
      ['Go to section 1–9', [MOD_LABEL, '1…9']],
      ['Close dialog or menu', ['Esc']]
    ]
  }
]

export function ShortcutsDialog() {
  const { shortcutsOpen, setShortcutsOpen } = useUi()
  return (
    <Modal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} title="Keyboard shortcuts" size="sm">
      <div className="flex flex-col gap-5">
        {GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            <h3 className="pb-1 text-2xs font-medium uppercase tracking-[0.07em] text-fg-faint">{group.title}</h3>
            {group.items.map(([label, keys]) => (
              <div key={label} className="flex h-8 items-center justify-between border-b border-line text-sm text-fg-muted last:border-0">
                {label}
                <KeyCombo keys={keys} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  )
}
