import { splitCitations } from './coordinator/citations'
import { siteSearchQuery } from './site-search'

export type ThreadReference = { kind: 'task' | 'thread' | 'pr'; id: string; title: string }
const pullRequest = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/

export function mentionAt(text: string, caret: number) {
  const match = /(?:^|\s)@(?:(task|thread|pr):)?([^\s@:]{0,120})$/u.exec(text.slice(0, caret))
  if (!match) return null
  return { from: match.index + match[0].indexOf('@'), end: caret, kind: match[1] as ThreadReference['kind'] | undefined, query: match[2] }
}

export function referenceMarker(item: ThreadReference) {
  return item.kind === 'pr' ? item.id : `[[${item.kind === 'task' ? 'issue' : 'run'}:${item.id}]]`
}

export function referenceQueryReady(query: string) {
  const parsed = siteSearchQuery(query)
  return parsed.kind === 'ready' || parsed.kind === 'empty' || /^[1-9]$/.test(query)
}

/** A person's other words, UUIDs, and Markdown stay literal. */
export function personReferenceParts(text: string) {
  return splitCitations(text).map(part => {
    if (part.type === 'citation' && part.kind) return { kind: part.kind === 'issue' ? 'task' as const : 'thread' as const, id: part.id }
    if (part.type === 'link' && pullRequest.test(part.url)) return { kind: 'pr' as const, id: part.url }
    return { kind: 'text' as const, text: part.type === 'text' ? part.text : part.raw }
  })
}
