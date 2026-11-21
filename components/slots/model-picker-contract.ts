// What the model-picker slot receives (docs/ui-overlay.md). Its menu, saves and
// refresh come from hooks/use-bot-model-picker.ts, which every implementation calls.

export type BotModelPickerProps = {
  /** The bot whose next runs use the model; null for the Coordinator. */
  botId: string | null
  /** A reply is going: a new pick applies to the next message (`data-next-message`). */
  running?: boolean
  /** Supply a thread's authorized catalogue and hold its pick until this turn is sent. */
  thread?: { scope: string; load: () => Promise<import('@/lib/bot-model-menu-view').BotModelMenu | null>;
    selected: string | null; choose: (id: string) => void }
}
