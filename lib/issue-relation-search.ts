import type { RelationKind, SearchResultItem } from '@/lib/issue-search'

/** Client side of GET /api/issues/search for the relation pickers (contract in lib/issue-search.ts). */
export const RELATION_SEARCH_DEBOUNCE_MS = 200
export const RELATION_SEARCH_LIMIT = 50
const SERVER_NUMBER = /^(?:(?:ORV|MIK)-)?[1-9]\d{0,8}$/i
const PREFIXED_NUMBER = /^[a-z][a-z0-9]*-([1-9]\d{0,8})$/i
const HASH_NUMBER = /^#([1-9]\d{0,8})$/
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u

/**
 * Maps what the user typed to the q the server accepts. A display identifier with another prefix
 * (a personal or Linear prefix such as ALEX-12) searches its number and keeps only that identifier;
 * #12 (an owner without a prefix yet) searches the number.
 * One non-CJK character is a 400 on the server, so it shows the recent list until a second one is typed.
 */
export function relationSearchQuery(raw: string): { q: string; identifier: string | null } {
  const text = raw.trim()
  if (SERVER_NUMBER.test(text)) return { q: text, identifier: null }
  const prefixed = PREFIXED_NUMBER.exec(text)
  if (prefixed) return { q: prefixed[1], identifier: text.toUpperCase() }
  const hash = HASH_NUMBER.exec(text)
  if (hash) return { q: hash[1], identifier: null }
  if ([...text].length === 1 && !CJK.test(text)) return { q: '', identifier: null }
  return { q: text.slice(0, 200), identifier: null }
}

/** A parent cannot be one of the issue's descendants, a sub-issue cannot be one of its ancestors. */
export function relationSearchParams(input: { issueId: string; kind: RelationKind; q: string }) {
  const params = new URLSearchParams({ q: input.q, issueId: input.issueId, relationKind: input.kind, excludeId: input.issueId, limit: String(RELATION_SEARCH_LIMIT) })
  if (input.kind === 'parent') params.set('excludeDescendants', 'true')
  if (input.kind === 'child') params.set('excludeAncestors', 'true')
  return params
}

/** Rows the picker offers: relatable per the server, not already a sub-issue when adding one, and matching a typed identifier. */
export function relationCandidates(items: SearchResultItem[], input: { kind: RelationKind; identifier: string | null }) {
  return items.filter(item => item.canRelate
    && !(input.kind === 'child' && item.existingRelation === 'child')
    && (!input.identifier || item.identifier?.toUpperCase() === input.identifier))
}
