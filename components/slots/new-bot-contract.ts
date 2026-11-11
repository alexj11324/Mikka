// What the new-bot slot receives (docs/ui-overlay.md). 新建 Bot (NewBotDialog, components/nav/new-bot-dialog.tsx)
// keeps its state and createBot; a layer draws the window from these props while it is open.
import type { BotColor, BotShape } from '@/components/nav/bot-avatar'

export type NewBotProps = {
  onClose: () => void
  name: string
  onName: (name: string) => void
  /** The name's longest length. */
  maxLength: number
  color: BotColor
  shape: BotShape
  onColor: (color: BotColor) => void
  onShape: (shape: BotShape) => void
  saving: boolean
  /** Creates the Bot; errors show as a toast and the window stays. */
  onSubmit: () => void
}
