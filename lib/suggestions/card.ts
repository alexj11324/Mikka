import type { SuggestionAction, SuggestionSource } from '@/lib/db/schema'

// A 建议 card the person tapped rides at the head of their message to the
// Coordinator, so the chat can draw the same card above the instruction (R-21):
//   <suggestion source="gmail" action="reply" title="Re: 周四的会">回复 Kevin：周四的会改到周三</suggestion>
//   <the full instruction>
// The body is the card's action line (R-45), empty when none was written yet.

export interface SuggestionCard {
  source: SuggestionSource
  action: SuggestionAction
  /** The source's own text: the email subject, the PR title. */
  title: string
  /** The item as an action for the person, or null before one is written. */
  actionTitle: string | null
}

// Kept here rather than imported from the schema so the chat can use this file without the database code.
export const CARD_SOURCES = ['gmail', 'slack', 'notion', 'github', 'linear'] as const satisfies readonly SuggestionSource[]
export const CARD_ACTIONS = ['reply', 'review', 'handle', 'read'] as const satisfies readonly SuggestionAction[]

/** How each app is written when a sentence mentions it. */
export const SOURCE_NAMES: Record<SuggestionSource, string> = { gmail: 'Gmail', slack: 'Slack', notion: 'Notion', github: 'GitHub', linear: 'Linear' }

const TEXT_MAX = 500
const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, ' ')
const escapeBody = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, ' ')
const unescape = (value: string) => value.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

/** The message text with the card in front. */
export function withSuggestion(text: string, card: SuggestionCard | null | undefined): string {
  if (!card) return text
  return `<suggestion source="${card.source}" action="${card.action}" title="${escapeAttribute(card.title.slice(0, TEXT_MAX))}">${escapeBody((card.actionTitle ?? '').slice(0, TEXT_MAX))}</suggestion>\n${text}`
}

const CARD = /^<suggestion ((?:[a-z]+="[^"]*"\s*)+)>([^<]*)<\/suggestion>\n?/

/** Splits a stored message into its card, if it starts with one, and the rest. */
export function splitSuggestion(message: string): { suggestion: SuggestionCard | null; text: string } {
  const match = CARD.exec(message)
  if (!match) return { suggestion: null, text: message }
  const attributes = Object.fromEntries([...match[1].matchAll(/([a-z]+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)]))
  const source = CARD_SOURCES.find(item => item === attributes.source)
  const action = CARD_ACTIONS.find(item => item === attributes.action)
  if (!source || !action || !attributes.title) return { suggestion: null, text: message }
  const body = unescape(match[2]).trim()
  return { suggestion: { source, action, title: attributes.title, actionTitle: body || null }, text: message.slice(match[0].length) }
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
