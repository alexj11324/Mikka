// Coordinator replies cite issues, runs and 建议 items with a token:
//
//   [[issue:<uuid>]]       an issue (task) on the board
//   [[run:<uuid>]]         a thread (agent run)
//   [[suggestion:<uuid>]]  a row of `suggestions`: an email, Slack message, PR,
//                          Notion page… (the briefing's `suggestionId`)
//
// The id is the row's lowercase or uppercase UUID, no spaces, and the token is
// written in place of the item's name in the sentence, e.g.
// 「先回 [[suggestion:3f6c…]]，再看 [[suggestion:a1b2…]]。」 The chat draws a
// suggestion as a mention chip (its app's mark and a short label) that opens
// the item; a token the person may not see stays plain text. Older replies name
// issues and runs by bare id (never suggestions). Web pages come as Markdown
// links or bare URLs. Everything cited is looked up for the person when the
// chat loads; web pages by their link preview.

export type CitationKind = 'issue' | 'run' | 'suggestion'

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
  /** The thread's name: the first line of what it was asked to do. */
  name: string
  /** How it ended, once it has. */
  summary: string | null
  /** Tool calls so far: the steps it handed to the coding agent. */
  steps: number
  createdAt: string
  finishedAt: string | null
}

/** The apps a 建议 item can come from; matches `SUGGESTION_SOURCES` in the schema. */
export type SuggestionApp = 'gmail' | 'slack' | 'notion' | 'github' | 'linear' | 'googlecalendar'

export interface SuggestionCitationSource {
  kind: 'suggestion'
  id: string
  app: SuggestionApp
  /** What the chip says: a few words, e.g. 「会议改期」 or `PR #212`. */
  label: string
  /** The source's own text, in full, for the hover card. */
  title: string
  /** Where the item lives in its app; null when it has no http(s) link. */
  url: string | null
}

export type CitationSource = IssueSource | RunSource | SuggestionCitationSource

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** ASCII only, so a URL followed by Chinese text with no space still ends at the URL. */
const URL_CHARS = '[^\\s<>()\\[\\]"\'`\\u0080-\\uffff]+'
const CITATION = new RegExp(`\\[([^\\]\\n]{1,200})\\]\\((https?://${URL_CHARS})\\)|(https?://${URL_CHARS})|\\[\\[(issue|run|suggestion):(${UUID})\\]\\]|\\b(${UUID})\\b`, 'gi')
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

/** Every id cited in `texts`: the ones to look up as issues, as runs, and as suggestions. Bare ids go in issues and runs. */
export function citedIds(texts: readonly string[]): { issueIds: string[]; runIds: string[]; suggestionIds: string[] } {
  const issueIds = new Set<string>()
  const runIds = new Set<string>()
  const suggestionIds = new Set<string>()
  for (const text of texts) {
    for (const part of splitCitations(text)) {
      if (part.type !== 'citation') continue
      if (part.kind === 'suggestion') { suggestionIds.add(part.id); continue }
      if (part.kind !== 'run') issueIds.add(part.id)
      if (part.kind !== 'issue') runIds.add(part.id)
    }
  }
  return { issueIds: [...issueIds], runIds: [...runIds], suggestionIds: [...suggestionIds] }
}

/** Characters a suggestion chip shows before it cuts the title. */
const LABEL_MAX = 16

/**
 * The chip's label for a 建议 item: its short action title when it has one,
 * `PR #212` / `Issue #212` for a GitHub link, else the title cut to a few words.
 */
export function suggestionLabel({ app, title, actionTitle, url }: { app: SuggestionApp; title: string; actionTitle?: string | null; url: string | null }): string {
  const short = actionTitle?.replace(/\s+/g, ' ').trim()
  if (short) return clip(short)
  if (app === 'github' && url) {
    const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)/.exec(url)
    if (match) return `${match[1] === 'pull' ? 'PR' : 'Issue'} #${match[2]}`
  }
  return clip(title.replace(/\s+/g, ' ').trim())
}

function clip(text: string): string {
  const chars = Array.from(text)
  return chars.length > LABEL_MAX ? `${chars.slice(0, LABEL_MAX - 1).join('').trimEnd()}…` : text
}

/**
 * The suggestions `userId` may cite, by id, from rows already fetched: a row
 * owned by anyone else is dropped, so a foreign id stays plain text.
 */
export function suggestionCitations(userId: string, rows: readonly { id: string; userId: string; source: SuggestionApp; title: string; url: string | null; actionTitle?: string | null }[]): Record<string, SuggestionCitationSource> {
  const sources: Record<string, SuggestionCitationSource> = {}
  for (const row of rows) {
    if (row.userId !== userId) continue
    const url = safeSourceUrl(row.url)
    sources[row.id] = { kind: 'suggestion', id: row.id, app: row.source, label: suggestionLabel({ app: row.source, title: row.title, actionTitle: row.actionTitle, url }), title: row.title, url }
  }
  return sources
}

/** `url` if it is an http(s) link, else null: a row's link never becomes a `javascript:` href. */
export function safeSourceUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  } catch { return null }
}

/** Where a citation link points, as `#cite/<kind|any>/<id>`; relative, so Markdown keeps it. */
export const CITATION_HREF = '#cite/'

type MdastNode = { type: string; value?: string; url?: string; children?: MdastNode[] }

/**
 * Remark plugin: turns [[issue:<id>]], [[run:<id>]], [[suggestion:<id>]] and bare ids in text into
 * links the citation anchor renders as chips, and keeps single line breaks,
 * since replies are written as plain text. Code is left alone.
 */
export function remarkCitations() {
  // GFM ends a bare URL only at ASCII space or punctuation, so a URL glued to Chinese text swallows it; cut it as splitCitations does.
  const autolink = (link: MdastNode): MdastNode[] => {
    const [first, ...rest] = splitCitations(link.url ?? '')
    if (first?.type !== 'link' || !rest.length) return [link]
    return [{ type: 'link', url: first.url, children: [{ type: 'text', value: first.url }] }, { type: 'text', value: rest.map(part => part.type === 'text' ? part.text : part.raw).join('') }]
  }
  return (tree: MdastNode) => {
    const walk = (node: MdastNode) => {
      if (!node.children || node.type === 'link' || node.type === 'linkReference') return
      node.children = node.children.flatMap(child => {
        if (child.type === 'link' && child.children?.length === 1 && child.children[0].value === child.url) return autolink(child)
        if (child.type !== 'text' || !child.value) { walk(child); return [child] }
        return splitCitations(child.value).flatMap<MdastNode>(part => {
          if (part.type === 'citation') return [{ type: 'link', url: `${CITATION_HREF}${part.kind ?? 'any'}/${part.id}`, children: [{ type: 'text', value: part.raw }] }]
          if (part.type === 'link') return [{ type: 'link', url: part.url, children: [{ type: 'text', value: part.label ?? part.url }] }]
          return part.text.split('\n').flatMap((line, index) => [...(index ? [{ type: 'break' }] : []), ...(line ? [{ type: 'text', value: line }] : [])])
        })
      })
    }
    walk(tree)
  }
}
