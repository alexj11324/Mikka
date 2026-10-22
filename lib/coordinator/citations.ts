// Coordinator replies cite issues and runs as [[issue:<id>]] or [[run:<id>]].
// Older replies name them by bare id. The chat shows both as source chips,
// looked up for the person when the chat loads.

export type CitationKind = 'issue' | 'run'

export type CitationPart =
  | { type: 'text'; text: string }
  /** `kind` is null for a bare id, which may be either. */
  | { type: 'citation'; kind: CitationKind | null; id: string; raw: string }

export interface IssueSource {
  kind: 'issue'
  id: string
  number: number | null
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
  issue: { id: string; number: number | null; title: string } | null
  createdAt: string
  finishedAt: string | null
}

export type CitationSource = IssueSource | RunSource

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const CITATION = new RegExp(`\\[\\[(issue|run):(${UUID})\\]\\]|\\b(${UUID})\\b`, 'gi')

/** Splits reply text into plain text and citations, in order. */
export function splitCitations(text: string): CitationPart[] {
  const parts: CitationPart[] = []
  let last = 0
  for (const match of text.matchAll(CITATION)) {
    if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) })
    const kind = match[1] ? match[1].toLowerCase() as CitationKind : null
    parts.push({ type: 'citation', kind, id: (match[2] ?? match[3]).toLowerCase(), raw: match[0] })
    last = match.index + match[0].length
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
