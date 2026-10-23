import { ShortcutKeys } from "@/components/shortcut-keys"

export function Pattern() {
  return (
    <div className="flex items-center justify-center gap-2">
      <ShortcutKeys keys={['mod']} />
      <ShortcutKeys keys={['mod', 'K']} />
      <ShortcutKeys keys={['mod', 'B']} />
    </div>
  )
}
