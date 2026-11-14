import { withBasePath } from '@/lib/base-path'
import { ListReadScopeError } from './live/list-read'

// Client side of GET /api/conversations/{id}/messages (lib/group-conversations-store.ts).
// The server requires a signed-in active workspace member who is still in the group;
// anything else, including an unknown id, is the same 404. Positions are bigint
// JSON strings, newest first; nextBefore continues to older messages.

export type GroupMessage = {
  id: string
  conversationId: string
  position: string
  authorType: 'user' | 'agent' | 'bot'
  authorId: string
  body: string
  mentions: { memberType: 'user' | 'agent' | 'bot'; memberId: string }[]
  replyToId: string | null
  createdAt: string
}
/** The first page also says which member is answering (`agentStatus`, null when none) and whether the last message found no taker. */
/** `stopped`: the latest reply was stopped (停止) by a member. */
export type GroupMessagePage = { messages: GroupMessage[]; nextBefore: string | null; agentStatus?: { status: string } | null; routingError?: { code: string } | null; stopped?: boolean; unchanged?: boolean; appended?: boolean; /** The group_chat key's revision, read before this newest page. */ revision?: number }
export type GroupMessagesError = 'unauthorized' | 'not_found' | 'unavailable'

export class GroupMessagesRequestError extends Error {
  readonly retryable: boolean
  constructor(public code: GroupMessagesError, readonly status = code === 'unauthorized' ? 401 : code === 'not_found' ? 404 : undefined, options?: ErrorOptions) {
    super(code, options)
    this.name = 'GroupMessagesRequestError'
    this.retryable = code !== 'not_found'
  }
}

export const GROUP_PAGE_SIZE = 50

export function groupMessagesUrl(id: string, before?: string | null, after?: string | null) {
  const params = new URLSearchParams({ limit: String(GROUP_PAGE_SIZE) })
  if (before) params.set('before', before)
  if (after) params.set('after', after)
  return withBasePath(`/api/conversations/${encodeURIComponent(id)}/messages?${params}`)
}

export async function fetchGroupMessages(id: string, before?: string | null, fetcher: typeof fetch = fetch, after?: string | null): Promise<GroupMessagePage> {
  let response: Response
  try { response = await fetcher(groupMessagesUrl(id, before, after), { cache: 'no-store', credentials: 'same-origin' }) }
  catch (cause) { throw new GroupMessagesRequestError('unavailable', undefined, { cause }) }
  const body = await response.json().catch(() => null) as GroupMessagePage | null
  if (response.ok && body && Array.isArray(body.messages)) return body
  throw new GroupMessagesRequestError(response.status === 401 ? 'unauthorized' : response.status === 404 ? 'not_found' : 'unavailable', response.status)
}

/** POST a message to the group; the bots it @mentions answer it, else the ones the server judges should. */
export async function postGroupMessage(id: string, body: string, mentions: GroupMessage['mentions'], fetcher: typeof fetch = fetch, operation?: { requestId: string; expectedOwnerId: string; expectedWorkspaceId: string }): Promise<GroupMessage> {
  let response: Response
  try {
    response = await fetcher(withBasePath(`/api/conversations/${encodeURIComponent(id)}/messages`), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body, mentions, ...operation }),
    })
  } catch (cause) { throw new GroupMessagesRequestError('unavailable', undefined, { cause }) }
  const sent = await response.json().catch(() => null) as GroupMessage | null
  if (response.ok && sent?.id) return sent
  throw new GroupMessagesRequestError(response.status === 401 ? 'unauthorized' : response.status === 404 ? 'not_found' : 'unavailable', response.status)
}

/** 停止: ends the reply the group is waiting on. Replies already posted stay. */
export async function stopGroupReply(id: string, fetcher: typeof fetch = fetch): Promise<void> {
  let response: Response
  try { response = await fetcher(withBasePath(`/api/conversations/${encodeURIComponent(id)}/stop`), { method: 'POST', credentials: 'same-origin' }) }
  catch (cause) { throw new GroupMessagesRequestError('unavailable', undefined, { cause }) }
  if (!response.ok) throw new GroupMessagesRequestError(response.status === 401 ? 'unauthorized' : response.status === 404 ? 'not_found' : 'unavailable', response.status)
}

/** A poll that already shows the latest message keeps that page. New messages are prepended; a full page replaces it. */
export function mergeGroupPoll(previous: GroupMessagePage | null, next: GroupMessagePage): GroupMessagePage {
  if (!previous) return next
  // Nothing new since the shown page: it is current at this read's revision.
  if (next.unchanged) return { ...previous, agentStatus: next.agentStatus ?? null, routingError: next.routingError ?? null, stopped: next.stopped, revision: next.revision }
  if (next.appended) {
    const seen = new Set(previous.messages.map(message => message.id))
    const added = next.messages.filter(message => !seen.has(message.id))
    return { ...previous, ...next, messages: [...added, ...previous.messages], nextBefore: previous.nextBefore, unchanged: undefined, appended: undefined }
  }
  return next
}

export function newestGroupPosition(messages: readonly GroupMessage[]): string | null {
  return messages.reduce<string | null>((max, message) => max === null || BigInt(message.position) > BigInt(max) ? message.position : max, null)
}

/** Pages arrive newest first; the chat reads oldest first. Duplicates (a page
 * boundary read twice) keep their first copy. */
export function chronological(pages: GroupMessagePage[]) {
  const seen = new Set<string>()
  const messages: GroupMessage[] = []
  for (const page of pages) for (const message of page.messages) if (!seen.has(message.id)) { seen.add(message.id); messages.push(message) }
  return messages.sort((a, b) => {
    const left = BigInt(a.position), right = BigInt(b.position)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/** R-13: consecutive messages from one author form a run; the name shows once
 * per run and the avatar sits at its bottom. */
export function authorRuns(messages: GroupMessage[]) {
  const runs: { key: string; authorType: GroupMessage['authorType']; authorId: string; messages: GroupMessage[] }[] = []
  for (const message of messages) {
    const last = runs.at(-1)
    if (last && last.authorType === message.authorType && last.authorId === message.authorId) last.messages.push(message)
    else runs.push({ key: message.id, authorType: message.authorType, authorId: message.authorId, messages: [message] })
  }
  return runs
}

/** GET a group API path; failures map to the same codes as the message pages. */
async function readGroupApi<T>(path: string, pick: (body: unknown) => T | undefined, fetcher: typeof fetch): Promise<T> {
  let response: Response
  try { response = await fetcher(withBasePath(path), { cache: 'no-store', credentials: 'same-origin' }) }
  catch (cause) { throw new GroupMessagesRequestError('unavailable', undefined, { cause }) }
  const value = response.ok ? pick(await response.json().catch(() => null)) : undefined
  if (value !== undefined) return value
  throw new GroupMessagesRequestError(response.status === 401 ? 'unauthorized' : response.status === 404 ? 'not_found' : 'unavailable', response.status)
}

const listIn = <T>(key: string) => (body: unknown) => {
  const value = (body as Record<string, unknown> | null)?.[key]
  return Array.isArray(value) ? value as T[] : undefined
}

/** A group chat the person is in, with its latest message (GET /api/conversations). */
export type GroupSummary = { unreadCount?: string; markedUnread?: boolean; id: string; workspaceId: string; title: string; createdAt: string; lastMessage: GroupMessage | null }

/** The person's group chats in one workspace, for the bot list (R-01). */
export function fetchGroups(workspaceId: string, fetcher: typeof fetch = fetch): Promise<GroupSummary[]> {
  return readGroupApi(`/api/conversations?${new URLSearchParams({ workspaceId })}`, listIn<GroupSummary>('conversations'), fetcher)
}

/** The list cache belongs to an owner/workspace, even if a cookie changes
 * while its GET is in flight. Legacy API consumers keep fetchGroups. */
export function fetchScopedGroups(ownerId: string, workspaceId: string, fetcher: typeof fetch = fetch): Promise<GroupSummary[]> {
  return readGroupApi(`/api/conversations?${new URLSearchParams({ workspaceId })}`, body => {
    const value = body as { viewerId?: unknown; workspaceId?: unknown } | null
    if (value?.viewerId !== ownerId) throw new ListReadScopeError('owner')
    if (value.workspaceId !== workspaceId) throw new ListReadScopeError('workspace')
    return listIn<GroupSummary>('conversations')(body)
  }, fetcher)
}

/** A group's members as GET /api/conversations/{id}/members returns them; bots carry their colour and shape. */
export type GroupMember = { id: string; name: string; memberType: 'user' | 'agent' | 'bot'; role?: 'owner' | 'member'; color?: string | null; shape?: string | null; coordinator?: boolean }

export function fetchGroupMembers(id: string, fetcher: typeof fetch = fetch): Promise<GroupMember[]> {
  return readGroupApi(`/api/conversations/${encodeURIComponent(id)}/members`, listIn<GroupMember>('members'), fetcher)
}

/** A member may leave their own group; owner transfer is deliberately a separate operation. */
export function mayLeaveGroup(members: readonly GroupMember[] | undefined, userId: string): boolean {
  return members?.some(item => item.memberType === 'user' && item.id === userId && item.role === 'member') ?? false
}

/** Voluntary departure uses the authenticated membership command, not an owner-only delete. */
export async function leaveGroupConversation(id: string, userId: string, fetcher: typeof fetch = fetch): Promise<void> {
  let response: Response
  try {
    response = await fetcher(withBasePath(`/api/conversations/${encodeURIComponent(id)}/members`), {
      method: 'DELETE', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberType: 'user', memberId: userId }),
    })
  } catch (cause) { throw new GroupMessagesRequestError('unavailable', undefined, { cause }) }
  if (response.ok && (await response.json().catch(() => null))?.ok === true) return
  throw new GroupMessagesRequestError(response.status === 401 ? 'unauthorized' : response.status === 404 ? 'not_found' : 'unavailable', response.status)
}

/** SWR can pass either an array key or an encoded infinite-page key. Revoke both, not just the visible list. */
export function revokedGroupCacheKey(key: unknown, id: string): boolean {
  if (Array.isArray(key)) return (key[0] === 'group-members' || key[0] === 'group-messages') && key[1] === id
  if (typeof key !== 'string') return false
  const encoded = key.startsWith('$inf$') ? key.slice(5) : key
  return encoded.startsWith(`@"group-messages",${JSON.stringify(id)},`) || encoded.startsWith(`@"group-members",${JSON.stringify(id)},`)
}
