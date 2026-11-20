// What the model-picker slot receives (docs/ui-overlay.md). Its menu, saves and
// refresh come from hooks/use-bot-model-picker.ts, either bound here or shared by the caller.

import type { BotModelPickerState } from '@/hooks/use-bot-model-picker'

export type BotModelPickerProps = {
  /** The bot whose next runs use the model; null for the Coordinator. */
  botId: string | null
  /** A reply is going: a new pick applies to the next message (`data-next-message`). */
  running?: boolean
  /** Keep the existing compact composer presentation where that control already lives. */
  presentation?: 'composer'
  /** The caller can share its existing picker with submission's model-save guard. */
  controller?: BotModelPickerState
  /** Supply a thread's authorized catalogue and hold its pick until this turn is sent. */
  thread?: { scope: string; load: () => Promise<import('@/lib/bot-model-menu-view').BotModelMenu | null>;
    selected: string | null; choose: (id: string) => void }
}
