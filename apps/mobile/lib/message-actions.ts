/**
 * The message a long press opened the action sheet for (app/message.tsx).
 * Held here rather than in route params: the words can be long, and 回复 has
 * to reach the chat that is still open under the sheet.
 */
export type HeldMessage = {
  /** Identifies the group and account that own a selection shown outside the chat. */
  scope?: string
  text: string
  onQuote: () => void
  /** A stored message can take a reaction: the person's current one, and how to set or clear it. */
  react?: { current: string | null; set: (emoji: string | null) => void }
  /** 选择文本 in the chat itself (#1408 Phase 3): the message's words become selectable where they are. */
  onSelect?: () => void
}

let held: HeldMessage | null = null
const listeners = new Set<() => void>()

export function holdMessage(message: HeldMessage) {
  held = message
  for (const listener of listeners) listener()
}
export const heldMessage = () => held

export function clearHeldMessage(scope: string) {
  if (held?.scope !== scope) return
  held = null
  for (const listener of listeners) listener()
}

export function subscribeHeldMessage(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The reactions a long press offers; the server takes only these (lib/reactions.ts). */
export const REACTIONS = ['❤️', '👍', '👎', '😂', '🎉', '🙏'] as const
