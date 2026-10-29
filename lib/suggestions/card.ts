import type { SuggestionAction, SuggestionSource } from '@/lib/db/schema'

// A 建议 card the person tapped is the whole of their message to the Coordinator
// (R-21): the chat draws the same card, and the Coordinator reads it as the task.
//   <suggestion source="gmail" action="reply" title="「Re: 周四的会」" actor="「Kevin」" url="「https://…」">「回复 Kevin：周四的会改到周三」</suggestion>
// Everything quoted 「…」 comes from the source app or was written from it, so it
// is content, never instructions (lib/coordinator/instructions.ts says so). Each
// value is one line, cut to a fixed length, with any 「」 of its own removed.
// The body is the card's action line (R-45), empty before one is written.

export interface SuggestionCard {
  source: SuggestionSource
  action: SuggestionAction
  /** The source's own text: the email subject, the PR title. */
  title: string
  /** The item as an action for the person, or null before one is written. */
  actionTitle: string | null
  /** Who it is from, as the source names them. */
  actor?: string | null
  /** The item in its app; http(s) only. */
  url?: string | null
}

// Kept here rather than imported from the schema so the chat can use this file without the database code.
export const CARD_SOURCES = ['gmail', 'slack', 'notion', 'github', 'linear'] as const satisfies readonly SuggestionSource[]
export const CARD_ACTIONS = ['reply', 'review', 'handle', 'read'] as const satisfies readonly SuggestionAction[]

/** How each app is written when a sentence mentions it. */
export const SOURCE_NAMES: Record<SuggestionSource, string> = { gmail: 'Gmail', slack: 'Slack', notion: 'Notion', github: 'GitHub', linear: 'Linear' }

/** How many characters each quoted value keeps. */
export const CARD_LIMITS = { title: 200, actionTitle: 200, actor: 100, url: 500 } as const

/** One line, no 「」 of its own, at most `max` characters. */
function clean(value: string | null | undefined, max: number): string {
  return [...(value ?? '').replace(/[「」]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim()
}
const webUrl = (value: string | null | undefined) => {
  const url = clean(value, CARD_LIMITS.url)
  return /^https?:\/\/\S+$/i.test(url) ? url : ''
}
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const unescape = (value: string) => value.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const quoted = (value: string) => `「${escape(value)}」`
const unquote = (value: string) => /^「[^「」]*」$/.test(value) ? value.slice(1, -1) : null

/** The message for a tapped card: the card and nothing else. */
export function suggestionMessage(card: SuggestionCard): string {
  const attributes = [`source="${card.source}"`, `action="${card.action}"`, `title="${quoted(clean(card.title, CARD_LIMITS.title))}"`]
  const actor = clean(card.actor, CARD_LIMITS.actor)
  if (actor) attributes.push(`actor="${quoted(actor)}"`)
  const url = webUrl(card.url)
  if (url) attributes.push(`url="${quoted(url)}"`)
  const line = clean(card.actionTitle, CARD_LIMITS.actionTitle)
  return `<suggestion ${attributes.join(' ')}>${line ? quoted(line) : ''}</suggestion>`
}

const CARD = /^<suggestion ((?:[a-z]+="[^"]*"\s*)+)>([^<]*)<\/suggestion>\n?/

/** Splits a stored message into its card, if it starts with one, and the rest. */
export function splitSuggestion(message: string): { suggestion: SuggestionCard | null; text: string } {
  const match = CARD.exec(message)
  if (!match) return { suggestion: null, text: message }
  const attributes = Object.fromEntries([...match[1].matchAll(/([a-z]+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)]))
  const source = CARD_SOURCES.find(item => item === attributes.source)
  const action = CARD_ACTIONS.find(item => item === attributes.action)
  const title = attributes.title === undefined ? null : unquote(attributes.title)
  const body = unescape(match[2])
  const actionTitle = body === '' ? '' : unquote(body)
  if (!source || !action || !title || actionTitle === null) return { suggestion: null, text: message }
  const actor = attributes.actor ? unquote(attributes.actor) : null
  const url = attributes.url ? webUrl(unquote(attributes.url)) : ''
  return { suggestion: { source, action, title, actionTitle: actionTitle || null, actor: actor || null, url: url || null }, text: message.slice(match[0].length) }
}

/** What the bubble under a sent card adds: the source's own words when the card shows its action line instead, and the link. */
export function cardExtras(card: SuggestionCard): { original: string | null; url: string | null } {
  const original = card.actionTitle && card.title.trim() !== card.actionTitle.trim() ? card.title : null
  return { original, url: card.url ?? null }
}

/** One piece of a card's sentence: plain words, or the app it names, drawn as a mention chip. */
export type CardPart = { kind: 'text'; text: string } | { kind: 'source'; source: SuggestionSource }

/**
 * The card's sentence in pieces: a verb chip, then the words with the app
 * named inline. An action line in Chinese starts with its verb (「回复 Kevin：…」,
 * lib/suggestions/action-title.ts), which becomes the chip; without an action
 * line the chip is the item's kind (`fallbackVerb`) and the words are the
 * source's own title. The app shows where the words name it, else in front.
 */
export function cardParts(card: Pick<SuggestionCard, 'source' | 'title' | 'actionTitle'>, fallbackVerb: string): { verb: string | null; parts: CardPart[] } {
  const line = card.actionTitle?.trim()
  const split = line ? /^([㐀-鿿]{1,4})\s+([\s\S]+)$/.exec(line) : null
  const verb = split ? split[1] : line ? null : fallbackVerb
  const words = split ? split[2] : line || card.title
  const name = SOURCE_NAMES[card.source]
  const at = words.toLowerCase().indexOf(name.toLowerCase())
  if (at < 0) return { verb, parts: [{ kind: 'source', source: card.source }, { kind: 'text', text: words }] }
  const parts: CardPart[] = []
  if (at > 0) parts.push({ kind: 'text', text: words.slice(0, at) })
  parts.push({ kind: 'source', source: card.source })
  const rest = words.slice(at + name.length)
  if (rest) parts.push({ kind: 'text', text: rest })
  return { verb, parts }
}
