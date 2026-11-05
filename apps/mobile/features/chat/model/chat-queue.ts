import type { ChatItem } from '@/lib/types'
import { splitChatFiles } from '@mikka/protocol/chat-attachments'
import { splitQuoted } from '@/lib/quote'

/**
 * A message the person sent waits in the bot's inbox (a `pending` item) until a turn takes it. A bot that is idle
 * takes one within a moment; while it answers something else the message waits, queued. The chat shows queued
 * messages above the composer rather than in the conversation, the next one first (#1408 Phase 3).
 */
export const QUEUED_AFTER_MS = 4_000

/**
 * The queued messages: pending while the bot works, either sent from this screen while it was already working
 * (`sentWhileWorking`, by text) or waiting longer than an idle bot would take. Oldest first.
 */
export function queuedItems(items: ChatItem[], working: boolean, now: number, sentWhileWorking: ReadonlySet<string> = new Set()) {
  if (!working) return []
  return items.filter(item => item.pending && item.from === 'person'
    && (sentWhileWorking.has(item.text) || now - Date.parse(item.createdAt) >= QUEUED_AFTER_MS))
}

/** One line for a queued message: its words without the quote it answers, or its files' names, or 照片. */
export function queuePreview(item: Pick<ChatItem, 'text' | 'images'>) {
  const { text, files } = splitChatFiles(item.text)
  const words = splitQuoted(text).words || text
  const line = words.replace(/\s+/g, ' ').trim()
  if (line) return line
  if (files.length) return files.map(file => file.name).join('、')
  return item.images ? '照片' : ''
}

/** When the oldest pending message turns queued, so the screen can look again then (a UI timer, not a read). */
export function nextQueueCheck(items: ChatItem[], working: boolean, now: number) {
  if (!working) return null
  const due = items.filter(item => item.pending && item.from === 'person').map(item => Date.parse(item.createdAt) + QUEUED_AFTER_MS).filter(at => at > now)
  return due.length ? Math.min(...due) : null
}
