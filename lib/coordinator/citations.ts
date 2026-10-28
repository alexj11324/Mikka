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
  /** The thread's name: the first line of what it was asked to do. */
  name: string
  /** How it ended, once it has. */
  summary: string | null
  /** Tool calls so far: the steps it handed to the coding agent. */
  steps: number
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

/** Where a citation link points, as `#cite/<kind|any>/<id>`; relative, so Markdown keeps it. */
export const CITATION_HREF = '#cite/'

type MdastNode = { type: string; value?: string; url?: string; children?: MdastNode[] }

/**
 * Remark plugin: turns [[issue:<id>]], [[run:<id>]] and bare ids in text into
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
