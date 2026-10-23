import { withBasePath } from '@/lib/base-path'
import { mergeReadPosition } from '@/lib/unread'

/**
 * Read-position API owned by Backend & Infra (table `conversation_reads`), confirmed shape:
 *   GET  /api/conversations/:id/read                         → ConversationRead
 *   POST /api/conversations/:id/read  { messageId }          → ConversationRead
 * Forward-only: an older message is ignored and the current state is returned (no error).
 * Unknown / other-conversation messageId → 422; non-member → 404.
 * POST parses JSON regardless of Content-Type, so sendBeacon works for the flush.
 */
export type ConversationRead = {
  lastReadMessageId: string | null
  lastReadPosition: number | null
  unreadCount: number
}
export type MarkReadBody = { messageId: string }

export type ReadTarget = { messageId: string; position: number }

/** A non-2xx answer from the read API; `status` is the HTTP status (422 unknown id, 403/404 no access). */
export class ReadError extends Error {
  constructor(readonly status: number) { super(`read ${status}`) }
}

export interface ConversationReadSource {
  get(conversationId: string): Promise<ConversationRead>
  mark(conversationId: string, target: ReadTarget): Promise<ConversationRead>
  /** Fire-and-forget during page hide / unmount; the next GET restores the position. */
  beacon(conversationId: string, target: ReadTarget): void
  subscribe?(conversationId: string, onChange: (read: ConversationRead) => void): () => void
  /** Mock only: the persisted message ids the page currently knows, so the mock can 422 like the server. */
  observe?(conversationId: string, messageIds: readonly string[]): void
}

const url = (id: string) => withBasePath(`/api/conversations/${encodeURIComponent(id)}/read`)

export const httpReadSource: ConversationReadSource = {
  async get(id) {
    const response = await fetch(url(id), { cache: 'no-store' })
    if (!response.ok) throw new ReadError(response.status)
    return response.json()
  },
  async mark(id, { messageId }) {
    const body: MarkReadBody = { messageId }
    const response = await fetch(url(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new ReadError(response.status)
    return response.json()
  },
  beacon(id, { messageId }) {
    const body = JSON.stringify({ messageId } satisfies MarkReadBody)
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(url(id), body)) return
    void fetch(url(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {})
  },
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
export const MOCK_READ_KEY = 'mikka:mock-conversation-read:'

/**
 * Local mock until Backend ships the API. Persists per conversation in localStorage so two
 * tabs share it (storage events) and e2e can seed it. Follows the server rules: messageId must
 * be a persisted message the page has observed (else 422), forward-only via max(). unreadCount
 * is 0 — the UI counts locally.
 *
 * Test-only knobs on the stored record: `simulateStatus` makes every mark fail with that status,
 * `posts` counts mark/beacon calls so e2e can assert there's no retry loop.
 */
export function createMockReadSource(storage: () => StorageLike | null = () => (typeof localStorage === 'undefined' ? null : localStorage)): ConversationReadSource {
  const memory = new Map<string, string>()
  const read = (id: string): ConversationRead => {
    const raw = storage()?.getItem(MOCK_READ_KEY + id) ?? memory.get(id)
    const value = raw ? JSON.parse(raw) as Partial<ConversationRead> : {}
    return { lastReadMessageId: value.lastReadMessageId ?? null, lastReadPosition: value.lastReadPosition ?? null, unreadCount: 0 }
  }
  const known = new Map<string, Set<string>>()
  const raw = (id: string) => { const value = storage()?.getItem(MOCK_READ_KEY + id) ?? memory.get(id); return value ? JSON.parse(value) as Record<string, unknown> : {} }
  const write = (id: string, value: Record<string, unknown>) => {
    const text = JSON.stringify(value)
    const store = storage()
    if (store) store.setItem(MOCK_READ_KEY + id, text)
    else memory.set(id, text)
  }
  const mark = (id: string, target: ReadTarget) => {
    const record = raw(id)
    write(id, { ...record, posts: (typeof record.posts === 'number' ? record.posts : 0) + 1 })
    if (typeof record.simulateStatus === 'number') throw new ReadError(record.simulateStatus)
    if (!known.get(id)?.has(target.messageId) || String(target.position) !== target.messageId) throw new ReadError(422)
    const current = read(id)
    const position = mergeReadPosition(current.lastReadPosition, target.position)
    if (position === current.lastReadPosition) return current
    const next: ConversationRead = { lastReadMessageId: target.messageId, lastReadPosition: position, unreadCount: 0 }
    write(id, { ...raw(id), ...next })
    return next
  }
  return {
    async get(id) { return read(id) },
    async mark(id, target) { return mark(id, target) },
    beacon(id, target) { try { mark(id, target) } catch { /* fire-and-forget */ } },
    observe(id, messageIds) { known.set(id, new Set(messageIds)) },
    subscribe(id, onChange) {
      if (typeof window === 'undefined') return () => {}
      const listener = (event: StorageEvent) => { if (event.key === MOCK_READ_KEY + id) onChange(read(id)) }
      window.addEventListener('storage', listener)
      return () => window.removeEventListener('storage', listener)
    },
  }
}

// TODO(MIK-8): switch to `httpReadSource` once Backend & Infra ship /api/conversations/:id/read.
export const conversationReadSource: ConversationReadSource = createMockReadSource()
