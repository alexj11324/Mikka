import { splitCitations } from './coordinator/citation-parts'
import { siteSearchQuery } from './site-search'

export type ThreadReference = { kind: 'task' | 'thread' | 'pr'; id: string; title: string; conversationKind?: 'chat' }
const pullRequest = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/

/** Source mentions belong to the repository-scoped file picker. */
export function sourceMentionAt(text: string, caret: number): boolean {
  return /(?:^|\s)@(file|folder)(?::[^\s]*)?$/i.test(text.slice(0, caret))
}

export function mentionAt(text: string, caret: number) {
  if (sourceMentionAt(text, caret)) return null
  const match = /(?:^|\s)@(?:(task|thread|pr):)?([^\s@:]{0,120})$/u.exec(text.slice(0, caret))
  if (!match) return null
  return { from: match.index + match[0].indexOf('@'), end: caret, kind: match[1] as ThreadReference['kind'] | undefined, query: match[2] }
}

export function referenceMarker(item: ThreadReference) {
  if (item.kind === 'pr') return item.id
  const kind = item.kind === 'task' ? 'issue' : item.conversationKind === 'chat' ? 'chat' : 'run'
  return `[[${kind}:${item.id}]]`
}

export function referenceQueryReady(query: string) {
  const parsed = siteSearchQuery(query)
  return parsed.kind === 'ready' || parsed.kind === 'empty' || /^[1-9]$/.test(query)
}

/** A person's other words, UUIDs, and Markdown stay literal. */
export function personReferenceParts(text: string) {
  return splitCitations(text, true).map(part => {
    if (part.type === 'chat') return { kind: 'chat' as const, id: part.id }
    if (part.type === 'citation' && part.kind) return { kind: part.kind === 'issue' ? 'task' as const : 'thread' as const, id: part.id }
    if (part.type === 'link' && pullRequest.test(part.url)) return { kind: 'pr' as const, id: part.url }
    return { kind: 'text' as const, text: part.type === 'text' ? part.text : part.raw }
  })
}
