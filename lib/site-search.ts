import { withBasePath } from '@/lib/base-path'

// Client side of GET /api/search (#310, docs/backend/131-site-search.md). The
// route sits under next.config's basePath, so requests go through withBasePath
// (/mikka/api/search when deployed). The types mirror lib/federated-search/types.ts
// on #310; replace them with that import once it is on main.

export type SiteSearchSource = 'history' | 'groups' | 'tasks'
export type SiteSearchItem = {
  id: string
  title: string
  timestamp: string
} & (
  | { type: 'task'; identifier: string | null; status: string; priority: string }
  | { type: 'history'; scope: 'owner' }
  | { type: 'group'; workspaceId: string }
)
export type SiteSearchPage = { source: SiteSearchSource; items: SiteSearchItem[]; nextCursor: string | null }

/** authRequired 401, searchAccessDenied 403, searchInvalidParam / searchQueryTooShort / searchQueryTooLong 400,
 * searchFailed 500. Anything else (404 before #310 is deployed, offline, bad JSON) is searchUnavailable. */
export type SiteSearchError = 'authRequired' | 'searchAccessDenied' | 'searchInvalidParam' | 'searchFailed' | 'searchUnavailable'

export class SiteSearchRequestError extends Error {
  constructor(public code: SiteSearchError, public status: number) { super(code) }
}

export const SITE_SEARCH_MAX_LENGTH = 200
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u

/** The server's query policy (parseSearchQuery): trimmed, at most 200 UTF-16 units,
 * one CJK character is enough, one other character is not. Checked before sending
 * so a half-typed query never shows an error. */
export function siteSearchQuery(raw: string): { kind: 'empty' } | { kind: 'tooShort' } | { kind: 'tooLong' } | { kind: 'ready'; q: string } {
  const q = raw.trim()
  if (!q) return { kind: 'empty' }
  if (q.length > SITE_SEARCH_MAX_LENGTH) return { kind: 'tooLong' }
  if ([...q].length === 1 && !CJK.test(q)) return { kind: 'tooShort' }
  return { kind: 'ready', q }
}

/** History is owner-scoped and takes no workspaceId (the server rejects one);
 * groups and tasks need the workspace that selects their sharing context. */
export function siteSearchUrl(source: SiteSearchSource, q: string, workspaceId: string | null, cursor?: string | null) {
  const params = new URLSearchParams({ source, q })
  if (source !== 'history') {
    if (!workspaceId) throw new Error(`${source} search needs a workspace`)
    params.set('workspaceId', workspaceId)
  }
  if (cursor) params.set('cursor', cursor)
  return withBasePath(`/api/search?${params}`)
}

const KNOWN_ERRORS = new Set<string>(['authRequired', 'searchAccessDenied', 'searchInvalidParam', 'searchQueryTooShort', 'searchQueryTooLong', 'searchFailed'])

async function requestPage(url: string, signal: AbortSignal | undefined, fetcher: typeof fetch): Promise<SiteSearchPage> {
  let response: Response
  try { response = await fetcher(url, { cache: 'no-store', credentials: 'same-origin', signal }) }
  catch (error) {
    if (signal?.aborted) throw error
    throw new SiteSearchRequestError('searchUnavailable', 0)
  }
  const body = await response.json().catch(() => null) as { error?: unknown } | SiteSearchPage | null
  if (response.ok && body && 'items' in body && Array.isArray(body.items)) return body
  const code = body && 'error' in body && typeof body.error === 'string' && KNOWN_ERRORS.has(body.error) ? body.error : null
  if (code === 'searchQueryTooShort' || code === 'searchQueryTooLong') throw new SiteSearchRequestError('searchInvalidParam', response.status)
  throw new SiteSearchRequestError((code as SiteSearchError | null) ?? 'searchUnavailable', response.status)
}

/** One page of one source. A 403 means access changed between the read and the
 * final check, and the whole page was withheld; the contract says to retry the
 * same request once for a fresh authorized page. A second 403 is final. */
export async function fetchSiteSearchPage(input: { source: SiteSearchSource; q: string; workspaceId: string | null; cursor?: string | null; signal?: AbortSignal }, fetcher: typeof fetch = fetch): Promise<SiteSearchPage> {
  const url = siteSearchUrl(input.source, input.q, input.workspaceId, input.cursor)
  try { return await requestPage(url, input.signal, fetcher) }
  catch (error) {
    if (!(error instanceof SiteSearchRequestError) || error.code !== 'searchAccessDenied') throw error
    return requestPage(url, input.signal, fetcher)
  }
}

/** Local and server results for the same thing are one row: local first (it has
 * more fields), then server hits it lacked, in server order. */
export function mergeById<T extends { id: string }, U extends { id: string }>(local: T[], remote: U[]): (T | U)[] {
  const seen = new Set(local.map(item => item.id))
  return [...local, ...remote.filter(item => !seen.has(item.id) && seen.add(item.id))]
}

/** cmdk-style containment used for the rows that stay client-side (Coordinator,
 * projects, quick actions, and recent rows shown before the server answers). */
export function matchesQuery(text: string, query: string) {
  const haystack = text.toLocaleLowerCase()
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word))
}
