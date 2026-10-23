// MIK-8 read positions (`conversation_reads`). Kept free of `server-only` and
// of the app's db singleton so the node:test suite can run it against
// dev-local with a plain pg Pool; the route passes the app pool.
//
// Contract (GET/POST /api/conversations/:id/read → ConversationRead):
// - 401 not signed in; 403 Origin present and its host differs from Host
//   (a missing Origin is allowed: same-origin GETs and some beacons omit it);
//   404 unknown conversation or not a member; 422 messageId missing, malformed,
//   not found, or in another conversation.
// - messageId is a coordinator_messages.id (uuid) or a numeric position
//   string (what PR #68's frontend sends: String(position)).
// - Forward-only: an older position is ignored and the current state returned.
// - unreadCount: Coordinator replies after lastReadPosition, counted the way
//   the chat shows them (consecutive assistant rows, with tool rows between
//   them, are one reply; see chatItems). The person's own messages and events
//   never count.

export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>
}

export interface ConversationRead {
  lastReadMessageId: string | null
  lastReadPosition: number | null
  unreadCount: number
}

export type ReadResult = { status: 200; body: ConversationRead } | { status: 401 | 403 | 404 | 422; body: { error: string } }

export const COORDINATOR_CONVERSATION = 'coordinator'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const POSITION = /^[1-9]\d{0,9}$/

/** The owner whose coordinator_messages back `conversationId`, or null when `userId` is not a member. */
export function conversationOwner(conversationId: string, userId: string): string | null {
  // Today the only conversation is the person's own Coordinator chat. Group
  // chats (MIK-11) will add a membership lookup here.
  return conversationId === COORDINATOR_CONVERSATION ? userId : null
}

/** Origin check: allowed when absent; otherwise its host must equal the request Host. */
export function originAllowed(origin: string | null, host: string | null): boolean {
  if (!origin) return true
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Resolves a messageId (uuid or position string) to a persisted message in the owner's conversation. */
export async function resolveMessage(q: Queryable, ownerId: string, messageId: unknown): Promise<{ id: string; position: number } | null> {
  if (typeof messageId !== 'string') return null
  const where = UUID.test(messageId) ? 'id = $2::uuid' : POSITION.test(messageId) ? 'position = $2::int' : null
  if (!where) return null
  const { rows } = await q.query<{ id: string; position: number }>(`select id::text as id, position from coordinator_messages where "userId" = $1 and ${where} limit 1`, [ownerId, messageId])
  return rows[0] ? { id: rows[0].id, position: Number(rows[0].position) } : null
}

async function unreadCount(q: Queryable, ownerId: string, after: number): Promise<number> {
  const { rows } = await q.query<{ n: string }>(`
    select count(*)::text as n from (
      select position, role, lag(role) over (order by position) as prev
      from (select position, message->>'role' as role from coordinator_messages
            where "userId" = $1 and message->>'role' in ('user', 'assistant')) m
    ) t
    where role = 'assistant' and prev is distinct from 'assistant' and position > $2`, [ownerId, after])
  return Number(rows[0]?.n ?? 0)
}

async function current(q: Queryable, userId: string, conversationId: string, ownerId: string): Promise<ConversationRead> {
  const { rows } = await q.query<{ lastReadPosition: number; lastReadMessageId: string | null }>(
    'select "lastReadPosition", "lastReadMessageId" from conversation_reads where "userId" = $1 and "conversationId" = $2', [userId, conversationId])
  const row = rows[0]
  const position = row ? Number(row.lastReadPosition) : null
  return { lastReadMessageId: row?.lastReadMessageId ?? null, lastReadPosition: position, unreadCount: await unreadCount(q, ownerId, position ?? 0) }
}

/**
 * Forward-only upsert in one statement: the position only rises, and the
 * message id and updatedAt change only when it does.
 */
export async function markRead(q: Queryable, userId: string, conversationId: string, ownerId: string, messageId: string, position: number): Promise<ConversationRead> {
  const { rows } = await q.query<{ lastReadPosition: number; lastReadMessageId: string | null }>(`
    insert into conversation_reads as r ("userId", "conversationId", "lastReadPosition", "lastReadMessageId", "updatedAt")
    values ($1, $2, $3, $4, now())
    on conflict ("userId", "conversationId") do update set
      "lastReadPosition" = greatest(r."lastReadPosition", excluded."lastReadPosition"),
      "lastReadMessageId" = case when excluded."lastReadPosition" > r."lastReadPosition" then excluded."lastReadMessageId" else r."lastReadMessageId" end,
      "updatedAt" = case when excluded."lastReadPosition" > r."lastReadPosition" then excluded."updatedAt" else r."updatedAt" end
    returning "lastReadPosition", "lastReadMessageId"`, [userId, conversationId, position, messageId])
  const row = rows[0]
  return { lastReadMessageId: row.lastReadMessageId, lastReadPosition: Number(row.lastReadPosition), unreadCount: await unreadCount(q, ownerId, Number(row.lastReadPosition)) }
}

export interface ReadRequest {
  method: 'GET' | 'POST'
  userId: string | null
  conversationId: string
  origin: string | null
  host: string | null
  /** Raw POST body text; parsed as JSON whatever the Content-Type (sendBeacon sends text/plain). */
  body?: string
}

/** The whole route, minus Next: status codes in the order 401, 403, 404, 422. */
export async function handleRead(q: Queryable, request: ReadRequest): Promise<ReadResult> {
  if (!request.userId) return { status: 401, body: { error: 'authRequired' } }
  if (!originAllowed(request.origin, request.host)) return { status: 403, body: { error: 'originNotAllowed' } }
  const ownerId = conversationOwner(request.conversationId, request.userId)
  if (!ownerId) return { status: 404, body: { error: 'conversationNotFound' } }
  if (request.method === 'GET') return { status: 200, body: await current(q, request.userId, request.conversationId, ownerId) }
  let messageId: unknown
  try {
    messageId = (JSON.parse(request.body ?? '') as { messageId?: unknown } | null)?.messageId
  } catch {
    messageId = undefined
  }
  const message = await resolveMessage(q, ownerId, messageId)
  if (!message) return { status: 422, body: { error: 'messageNotFound' } }
  // Echo the id form the client used, so String(position) round-trips for PR #68.
  return { status: 200, body: await markRead(q, request.userId, request.conversationId, ownerId, messageId as string, message.position) }
}
