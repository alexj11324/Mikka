/** Shared message syntax for the coordinator, task threads and native chat. */
export type CitationKind = 'issue' | 'run'

export type CitationPart =
  | { type: 'text'; text: string }
  /** `kind` is null for a bare id, which may be either. */
  | { type: 'citation'; kind: CitationKind | null; id: string; raw: string }
  /** A web page; `label` is the Markdown link text, if any. */
  | { type: 'link'; url: string; label: string | null; raw: string }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** ASCII only, so a URL followed by Chinese text with no space still ends at the URL. */
const URL_CHARS = '[^\\s<>()\\[\\]"\'`\\u0080-\\uffff]+'
const citationPattern = (kinds: string) => new RegExp(`\\[([^\\]\\n]{1,200})\\]\\((https?://${URL_CHARS})\\)|(https?://${URL_CHARS})|\\[\\[(${kinds}):(${UUID})\\]\\]|\\b(${UUID})\\b`, 'gi')
const CITATION = citationPattern('issue|run')
const WITH_NAMED_CHAT = citationPattern('issue|run|chat')
type NamedChatPart = { type: 'chat'; id: string }

/** Punctuation that ends a sentence rather than a bare URL. */
const TRAILING = /[.,;:!?。，；：！？、）]+$/

/** Splits reply text into plain text and citations, in order. */
export function splitCitations(text: string): CitationPart[]
export function splitCitations(text: string, namedChats: true): (CitationPart | NamedChatPart)[]
export function splitCitations(text: string, namedChats = false): (CitationPart | NamedChatPart)[] {
  const parts: (CitationPart | NamedChatPart)[] = []
  let last = 0
  for (const match of text.matchAll(namedChats ? WITH_NAMED_CHAT : CITATION)) {
    if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) })
    let raw = match[0]
    if (match[2]) parts.push({ type: 'link', url: match[2], label: match[1].trim() || null, raw })
    else if (match[3]) {
      raw = match[3].replace(TRAILING, '')
      parts.push({ type: 'link', url: raw, label: null, raw })
    } else if (match[4]?.toLowerCase() === 'chat') parts.push({ type: 'chat', id: match[5].toLowerCase() })
    else parts.push({ type: 'citation', kind: match[4] ? match[4].toLowerCase() as CitationKind : null, id: (match[5] ?? match[6]).toLowerCase(), raw })
    last = match.index + raw.length
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) })
  return parts
}
