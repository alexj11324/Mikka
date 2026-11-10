/**
 * Text selected in one message (#1408 Phase 3): the capsules above the composer each send a reply that quotes the
 * selection with a short instruction, at once. The quote is Markdown, as a swipe-to-quote reply is.
 */
export type SelectionAction = { key: string; label: string; instruction: string }

export const SELECTION_ACTIONS: readonly SelectionAction[] = [
  { key: 'explain', label: '解释', instruction: '解释这段。' },
  { key: 'expand', label: '展开', instruction: '展开说说这段。' },
  { key: 'shorten', label: '缩短', instruction: '把这段改短。' },
  { key: 'rewrite', label: '改写', instruction: '换个说法重写这段。' },
  { key: 'translate', label: '翻译', instruction: '翻译这段：中文译成英文，其他语言译成中文。' },
]

/**
 * 添加到对话 (Alex 2026-11-08), first in the row: the selection goes into the composer as its quote, as Codex adds a
 * selection to the conversation; nothing is sent. It replaces swipe-to-quote.
 */
export const ADD_TO_CHAT: SelectionAction = { key: 'add', label: '添加到对话', instruction: '' }

/** The capsules above the composer while words are selected. */
export const SELECTION_BAR: readonly SelectionAction[] = [ADD_TO_CHAT, ...SELECTION_ACTIONS]

/** A message quoting `quote` (each line marked `> `), then `words`. */
export function quotedMessage(quote: string, words: string) {
  const lines = quote.trim().split('\n').map(line => `> ${line}`).join('\n')
  return words ? `${lines}\n\n${words}` : lines
}

/** What a capsule quotes: the selected part, or the whole message when nothing is selected. */
export function selectionQuote(selected: string, whole: string) {
  return selected.trim() || whole.trim()
}

/** The selected part of `text` for a native selection range, clamped to the text. */
export function selectedPart(text: string, start: number, end: number) {
  const from = Math.max(0, Math.min(start, end, text.length))
  const to = Math.min(text.length, Math.max(start, end, 0))
  return text.slice(from, to)
}

/** How far a touch may move, and how long it may last, and still count as a tap that ends the selection. */
export const TAP_SLOP = 10
export const TAP_MS = 400
/** Room around the selected message for its selection handles: a tap there keeps the selection. */
export const HANDLE_SLOP = 24

export type Rect = { x: number; y: number; width: number; height: number }

/**
 * Whether a touch that started at `down` and ended at `up` is a tap outside `rect` (the selected message) and should
 * end the selection. A scroll, a hold or a tap on the message or its handles keeps it.
 */
export function endsSelection(down: { x: number; y: number; at: number }, up: { x: number; y: number; at: number }, rect: Rect | null) {
  if (Math.hypot(up.x - down.x, up.y - down.y) > TAP_SLOP || up.at - down.at > TAP_MS) return false
  if (!rect) return true
  const inside = up.x >= rect.x - HANDLE_SLOP && up.x <= rect.x + rect.width + HANDLE_SLOP
    && up.y >= rect.y - HANDLE_SLOP && up.y <= rect.y + rect.height + HANDLE_SLOP
  return !inside
}
