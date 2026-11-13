// Coordinator replies cite issues and runs as [[issue:<id>]] or [[run:<id>]].
// Older replies name them by bare id. Web pages come as Markdown links or bare
// URLs. The chat shows all of them as source chips: issues and runs looked up
// for the person when the chat loads, web pages by their link preview.

import { conversationTitle } from '../short-title'

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
  run?: { status: string; outcome: string | null; stopReason?: string | null } | null
  /** Its pull requests, for the same state (a merged PR is done, an open one waits for review). */
  pullRequests?: import('@/lib/issue-metadata').IssuePullRequest[]
  review?: import('@/lib/coding-workspace/task-review/read').TaskReviewSummary | null
}

export interface RunSource {
  kind: 'run'
  id: string
  agentName: string
  harness: string
  status: string
  /** How it came out once it ended (R-52); null while running or not judged yet. */
  outcome?: string | null
  /** Why it stopped (lib/agent-runs runViewColumns); `asked_human` says it ended on a question. */
  stopReason?: string | null
  /** Its group in the thread list (R-52), decided on the server: the phone draws it as is. */
  group?: import('@/lib/thread-groups').ThreadGroup
  issue: { id: string; number: number | null; identifier: string | null; title: string; shortTitle?: string | null; status?: string; run?: { status: string; outcome: string | null; stopReason?: string | null } | null; review?: import('@/lib/coding-workspace/task-review/read').TaskReviewSummary | null } | null
  /** The conversation's own stored short title, once it has one (agent_runs.title of the chain's first run). */
  title?: string | null
  /** The first line of what it was asked to do; its shown name is runThreadName. */
  name: string
  /** How it ended, once it has. */
  summary: string | null
  /** Tool calls so far: the steps it handed to the coding agent. */
  steps: number
  createdAt: string
  finishedAt: string | null
  /** Task outputs, already filtered through the viewer's task access. */
  pullRequests?: import('@/lib/issue-metadata').IssuePullRequest[]
  /** 运行信息, for the viewer's own runs: where it ran, on what, who pays (lib/run-info.ts). */
  info?: import('@/lib/run-info-view').RunInfo
}

export type CitationSource = IssueSource | RunSource

/** A thread's name where a row or a card names it: its task's code, when it has one, and the conversation's short title. */
export function runThreadName(run: Pick<RunSource, 'issue' | 'name' | 'title'>) {
  return [run.issue?.identifier, runTitle(run)].filter(Boolean).join(' ')
}

/**
 * A thread's title wherever it is named: the conversation's one bounded short title (lib/short-title.ts
 * conversationTitle, decision 2026-11-13-1405), never its task's full title and never with the code, which the task's
 * own chip carries.
 */
export function runTitle(run: Pick<RunSource, 'issue' | 'name' | 'title'>) {
  return conversationTitle(run)
}

/**
 * Marks a `[[run:…]]` that directly follows an `[[issue:…]]` (nothing but spaces between): when that thread belongs to
 * that task, the two read as one reference, the task's chip and then the thread's title. The gap between them is dropped here: the
 * thread draws one word gap itself, so nothing is left behind when its title is left out beside its card.
 */
export function pairCitations(parts: readonly CitationPart[]): (CitationPart & { after?: string })[] {
  const out: (CitationPart & { after?: string })[] = []
  for (const part of parts) {
    const gap = out.at(-1), before = gap?.type === 'text' && !gap.text.trim() && !gap.text.includes('\n') ? out.at(-2) : gap
    if (part.type === 'citation' && part.kind === 'run' && before?.type === 'citation' && before.kind === 'issue') {
      if (gap !== before) out.pop()
      out.push({ ...part, after: before.id })
    } else out.push(part)
  }
  return out
}

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

/** The start of a `[[issue:<id>]]` or `[[run:<id>]]` at the very end of the text, up to its last `]`. */
const PARTIAL_CITATION = /\[(?:\[(?:i(?:s(?:s(?:u(?:e(?::[0-9a-f-]{0,36}\]?)?)?)?)?)?|r(?:u(?:n(?::[0-9a-f-]{0,36}\]?)?)?)?)?)?$/i

/** Streamed text without a citation that has not fully arrived, so its marker never shows before its chip. */
export function withoutPartialCitation(text: string): string {
  return text.replace(PARTIAL_CITATION, '')
}

/** Every id cited in `texts`:the ones to look up as issues, and as runs. Bare ids go in both. */
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

/**
 * `text` with each cited issue or run written as the name its chip shows (a
 * thread's name, a task's title), for one-line previews such as the bot list.
 * A citation this person cannot see is left out, never shown as its id.
 * OpenUI Lang (`name = Component(…)`) comes back as it is: its ids are
 * arguments, and the preview reads its prose from the quoted strings.
 */
/** What `namedCitations` reads of a source. */
export type CitationName = { kind: 'issue'; title: string } | { kind: 'run'; name: string }

export function namedCitations(text: string, sources: Readonly<Record<string, CitationName>>): string {
  if (/^\w+\s*=/.test(text.trimStart())) return text
  return splitCitations(text).map(part => {
    if (part.type === 'text') return part.text
    if (part.type === 'link') return part.raw
    const source = sources[part.id]
    if (!source || (part.kind && part.kind !== source.kind)) return ''
    return source.kind === 'run' ? source.name : source.title
  }).join('')
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
        return pairCitations(splitCitations(child.value)).flatMap<MdastNode>(part => {
          if (part.type === 'citation') return [{ type: 'link', url: `${CITATION_HREF}${part.kind ?? 'any'}/${part.id}${part.after ? `/after/${part.after}` : ''}`, children: [{ type: 'text', value: part.raw }] }]
          if (part.type === 'link') return [{ type: 'link', url: part.url, children: [{ type: 'text', value: part.label ?? part.url }] }]
          return part.text.split('\n').flatMap((line, index) => [...(index ? [{ type: 'break' }] : []), ...(line ? [{ type: 'text', value: line }] : [])])
        })
      })
    }
    walk(tree)
  }
}
