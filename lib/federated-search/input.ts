import { createHash } from 'node:crypto'
import { z } from 'zod'
import { parseSearchQuery, SearchInputError } from '@/lib/issue-search'
import type { SearchSource } from './types'

export class UnsupportedSourceError extends Error {}
const time = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 23) === value.slice(0, 23))
const cursorSchema = z.object({ v: z.literal(1), binding: z.string().length(64), key: z.object({ time, id: z.uuid() }).strict() }).strict()
export type TitleCursor = z.infer<typeof cursorSchema>['key']
export type SearchInput = { source: SearchSource; q: string; workspaceId: string | null; limit: number; cursor: TitleCursor | null; binding: string }
export function parseInput(params: URLSearchParams, userId: string): SearchInput {
  // Reject ignored selectors rather than silently widening a request.
  for (const key of params.keys()) if (!['source', 'q', 'workspaceId', 'limit', 'cursor'].includes(key) || params.getAll(key).length !== 1) throw new SearchInputError('searchInvalidParam')
  const source = params.get('source')
  if (source === 'agents' || source === 'knowledge') throw new UnsupportedSourceError(source)
  if (source !== 'tasks' && source !== 'history' && source !== 'groups') throw new SearchInputError('searchInvalidParam')
  const q = (params.get('q') ?? '').trim()
  parseSearchQuery(q) // Shared length/minimum policy; numeric history/group queries remain literal titles.
  const workspaceId = params.get('workspaceId')
  if (source === 'history' ? workspaceId !== null : !z.uuid().safeParse(workspaceId).success) throw new SearchInputError('searchInvalidParam')
  const rawLimit = params.get('limit')
  if (rawLimit !== null && !/^[1-9]\d?$/.test(rawLimit)) throw new SearchInputError('searchInvalidParam')
  const limit = rawLimit === null ? 20 : Number(rawLimit)
  if (limit > 50) throw new SearchInputError('searchInvalidParam')
  const binding = createHash('sha256').update(JSON.stringify([userId, source, workspaceId, q])).digest('hex')
  const raw = params.get('cursor')
  let cursor: TitleCursor | null = null
  if (raw !== null) {
    if (raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new SearchInputError('searchInvalidParam')
    try {
      const decoded = cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')))
      if (decoded.binding !== binding) throw new Error('context mismatch')
      cursor = decoded.key
    } catch { throw new SearchInputError('searchInvalidParam') }
  }
  return { source, q, workspaceId, limit, cursor, binding }
}
export function nextCursor(input: SearchInput, key: TitleCursor) {
  return Buffer.from(JSON.stringify({ v: 1, binding: input.binding, key })).toString('base64url')
}
