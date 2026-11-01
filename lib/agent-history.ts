import { detectAgentUISource } from './agent-ui-source'
import { isComponent, openUIText, parseOpenUI, splitOpenUI, type Value } from './openui-lang'

export type SavedAgentSession = { id: string; title: string; updatedAt: string; preview?: string }

/**
 * Chat markdown as one plain line, shared by the bot list's preview and the
 * right column's thread rows: citation tokens ([[issue:…]]) and link targets
 * go, as do heading, quote and list markers, bold, strikethrough, *italic*
 * and code ticks. Single underscores stay, so MIKKA_R2_ACCESS_KEY reads as written.
 */
export function markdownLine(text: string): string {
  return text
    .replace(/\[\[(?:issue|run):[0-9a-f-]{36}\]\]/gi, '')
    .replace(/!?\[([^\]\n]*)\]\([^)\s]+\)/g, '$1')
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, '')
    .replace(/(\*\*|__|~~)(\S(?:[\s\S]*?\S)?)\1/g, '$2')
    .replace(/\*(\S(?:[^*\n]*?\S)?)\*/g, '$1')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * One line of plain text for the conversation list: the first sentence-sized
 * string in the reply (OpenUI Lang keeps prose in quoted arguments), else
 * plain-text replies as they are, else the person's last message.
 */
export function sessionPreview(completion: string | null | undefined, prompt: string | null | undefined): string {
  const reply = completion?.trim() ?? ''
  for (const match of reply.matchAll(/"((?:[^"\\\n]|\\.){4,})"/g)) {
    try {
      const text = (JSON.parse(`"${match[1]}"`) as string).replace(/\s+/g, ' ').trim()
      if (/[\p{L}\p{N}]/u.test(text) && !/^[\w-]+$/.test(text)) return text.slice(0, 120)
    } catch { /* not a JSON string literal */ }
  }
  if (reply && !/^\w+\s*=/.test(reply)) return reply.replace(/[#*`>_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return (prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

const CHARTS = new Set(['BarChart', 'LineChart', 'AreaChart', 'DonutChart', 'RadialChart'])

/** A card without its charts: their axis labels and series names are not words to quote. */
function withoutCharts(value: Value): Value {
  if (Array.isArray(value)) return value.map(withoutCharts)
  if (isComponent(value)) return CHARTS.has(value.name) ? null : { ...value, props: Object.fromEntries(Object.entries(value.props).map(([key, prop]) => [key, withoutCharts(prop)])), args: value.args.map(withoutCharts) }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutCharts(item)]))
  return value
}

/**
 * A chat message as the one plain line a bot or group row shows, on the web
 * and on the phone. Markdown reads as its text. An OpenUI reply reads as the
 * first words it shows (its prose, then its cards' text), never its source;
 * null when it shows no words (charts only, or a card that does not parse),
 * and the row shows its card placeholder instead.
 */
export function chatPreview(text: string): string | null {
  const detected = detectAgentUISource(text)
  if (!detected.isOpenUI) return markdownLine(text).slice(0, 120)
  const card = parseOpenUI(detected.source)
  const words = [splitOpenUI(detected.source)?.prose ?? '', card === null ? '' : openUIText(withoutCharts(card))]
  for (const line of words.join('\n').split('\n')) {
    const plain = markdownLine(line)
    if (plain) return plain.slice(0, 120)
  }
  return null
}

export type SavedAgentTurn = { id: string; prompt: string; completion: string; status: 'pending' | 'complete' | 'failed' | 'stopped'; error: string | null }
/** Optional while clients and servers roll forward independently. The current GET
 * returns the selected owner's title even when it is outside the recent list. */
export type AgentHistory = { sessions: SavedAgentSession[]; sessionId: string | null; selectedSession?: { id: string; title: string } | null; turns: SavedAgentTurn[] }
