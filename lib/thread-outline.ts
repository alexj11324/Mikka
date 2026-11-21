import type { ThreadItem } from './issue-run-conversation'

/**
 * A long thread's jump index: one entry per thing a person said, so a reader
 * can move between the moments that structure the conversation instead of
 * scrolling through dozens of turns.
 *
 * This is NOT the document outline. `issue-editor.tsx` already has one
 * (`useRichTextOutline`), and it expands the headings of a task's description.
 * Naming this `outline` too would repeat the older mistake where one word meant
 * two things: a reader searching for the description's headings would land on
 * the conversation's index instead.
 *
 * It is a pure projection of items `threadItems()` has already built, never a
 * second fold of the chunk stream: a second cursor over the same data is how
 * two views of one conversation drift apart.
 */
export interface ThreadOutlineEntry {
  /** The `ThreadItem` id, which is also its `data-thread-item` anchor in the list. */
  id: string
  /** Who said it, as the thread shows them. Empty for a message with no author. */
  author: string
  /** The whole text, untruncated: the panel decides how much of it to show. */
  text: string
  /** Epoch milliseconds, the same clock `ThreadItem.at` uses. */
  at: number
  /** The reader wrote it, so the index can mark it as their own. */
  mine: boolean
}

/**
 * The jump index for one thread, in the order the conversation reads.
 *
 * A person's message with no text (an attachment-only turn) is left out: it
 * would be an unlabelled row that jumps somewhere the reader cannot see a
 * reason for. `threadItems` drops empty agent text the same way.
 */
export function threadOutline(items: readonly ThreadItem[]): ThreadOutlineEntry[] {
  const entries: ThreadOutlineEntry[] = []
  for (const item of items) {
    if (item.kind !== 'person') continue
    if (!item.text.trim()) continue
    entries.push({ id: item.id, author: item.author, text: item.text, at: item.at, mine: item.mine })
  }
  return entries
}
