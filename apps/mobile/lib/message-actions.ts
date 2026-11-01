/**
 * The message a long press opened the action sheet for (app/message.tsx).
 * Held here rather than in route params: the words can be long, and 回复 has
 * to reach the chat that is still open under the sheet.
 */
export type HeldMessage = {
  text: string
  onQuote: () => void
  /** A stored message can take a reaction: the person's current one, and how to set or clear it. */
  react?: { current: string | null; set: (emoji: string | null) => void }
}

let held: HeldMessage | null = null

export const holdMessage = (message: HeldMessage) => { held = message }
export const heldMessage = () => held

/** The reactions a long press offers; the server takes only these (lib/reactions.ts). */
export const REACTIONS = ['❤️', '👍', '👎', '😂', '🎉', '🙏'] as const
