// Coordinator replies cite issues and runs as [[issue:<id>]] or [[run:<id>]].
// Older replies name them by bare id. Web pages come as Markdown links or bare
// URLs. The chat shows all of them as source chips: issues and runs looked up
// for the person when the chat loads, web pages by their link preview.

export type CitationKind = 'issue' | 'run'

export type CitationPart =
  | { type: 'text'; text: string }
  /** `kind` is null for a bare id, which may be either. */
  | { type: 'citation'; kind: CitationKind | null; id: string; raw: string }
  /** A web page; `label` is the Markdown link text, if any. */
  | { type: 'link'; url: string; label: string | null; raw: string }

export interface IssueSource {
  kind: 'issue'
  id: string
  number: number | null
  /** `MIK-12` or `ALEX-12`, from `taskIdentifier`. */
  identifier: string | null
  title: string
  status: string
  priority: string
}

export interface RunSource {
  kind: 'run'
  id: string
  agentName: string
  harness: string
  status: string
  issue: { id: string; number: number | null; identifier: string | null; title: string } | null
  createdAt: string
  finishedAt: string | null
}

export type CitationSource = IssueSource | RunSource

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** ASCII only, so a URL followed by Chinese text with no space still ends at the URL. */
const URL_CHARS = '[^\\s<>()\\[\\]"\'`\\u0080-\\uffff]+'
const CITATION = new RegExp(`\\[([^\\]\\n]{1,200})\\]\\((https?://${URL_CHARS})\\)|(https?://${URL_CHARS})|\\[\\[(issue|run):(${UUID})\\]\\]|\\b(${UUID})\\b`, 'gi')
/** Punctuation that ends a sentence rather than a bare URL. */
const TRAILING = /[.,;:!?。，；：！？、）]+$/

/** Splits reply text into plain text and citations, in order. */
export function splitCitations(text: string): CitationPart[] {
  const parts: CitationPart[] = []
  let last = 0
  for (const match of text.matchAll(CITATION)) {
    if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) })
    let raw = match[0]
    if (match[2]) parts.push({ type: 'link', url: match[2], label: match[1].trim() || null, raw })
    else if (match[3]) {
      raw = match[3].replace(TRAILING, '')
      parts.push({ type: 'link', url: raw, label: null, raw })
    } else parts.push({ type: 'citation', kind: match[4] ? match[4].toLowerCase() as CitationKind : null, id: (match[5] ?? match[6]).toLowerCase(), raw })
    last = match.index + raw.length
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) })
  return parts
}

/** Every id cited in `texts`: the ones to look up as issues, and as runs. Bare ids go in both. */
export function citedIds(texts: readonly string[]): { issueIds: string[]; runIds: string[] } {
  const issueIds = new Set<string>()
  const runIds = new Set<string>()
  for (const text of texts) {
    for (const part of splitCitations(text)) {
      if (part.type !== 'citation') continue
      if (part.kind !== 'run') issueIds.add(part.id)
      if (part.kind !== 'issue') runIds.add(part.id)
    }
  }
  return { issueIds: [...issueIds], runIds: [...runIds] }
}
