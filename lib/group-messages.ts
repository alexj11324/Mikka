import { withBasePath } from '@/lib/base-path'

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
export type GroupMessagePage = { messages: GroupMessage[]; nextBefore: string | null; agentStatus?: { status: string } | null; routingError?: { code: string } | null }
export type GroupMessagesError = 'unauthorized' | 'not_found' | 'unavailable'

export class GroupMessagesRequestError extends Error {
  constructor(public code: GroupMessagesError) { super(code) }
}

export const GROUP_PAGE_SIZE = 50

export function groupMessagesUrl(id: string, before?: string | null) {
  const params = new URLSearchParams({ limit: String(GROUP_PAGE_SIZE) })
  if (before) params.set('before', before)
  return withBasePath(`/api/conversations/${encodeURIComponent(id)}/messages?${params}`)
}

export async function fetchGroupMessages(id: string, before?: string | null, fetcher: typeof fetch = fetch): Promise<GroupMessagePage> {
  let response: Response
  try { response = await fetcher(groupMessagesUrl(id, before), { cache: 'no-store', credentials: 'same-origin' }) }
  catch { throw new GroupMessagesRequestError('unavailable') }
  const body = await response.json().catch(() => null) as GroupMessagePage | null
  if (response.ok && body && Array.isArray(body.messages)) return body
  throw new GroupMessagesRequestError(response.status === 401 ? 'unauthorized' : response.status === 404 ? 'not_found' : 'unavailable')
}

/** POST a message to the group; the bots it @mentions answer it, else the ones the server judges should. */
export async function postGroupMessage(id: string, body: string, mentions: GroupMessage['mentions'], fetcher: typeof fetch = fetch): Promise<GroupMessage> {
  let response: Response
  try {
    response = await fetcher(withBasePath(`/api/conversations/${encodeURIComponent(id)}/messages`), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body, mentions }),
    })
  } catch { throw new GroupMessagesRequestError('unavailable') }
  const sent = await response.json().catch(() => null) as GroupMessage | null
  if (response.ok && sent?.id) return sent
  throw new GroupMessagesRequestError(response.status === 401 ? 'unauthorized' : response.status === 404 ? 'not_found' : 'unavailable')
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
  catch { throw new GroupMessagesRequestError('unavailable') }
  const value = response.ok ? pick(await response.json().catch(() => null)) : undefined
  if (value !== undefined) return value
  throw new GroupMessagesRequestError(response.status === 401 ? 'unauthorized' : response.status === 404 ? 'not_found' : 'unavailable')
}

const listIn = <T>(key: string) => (body: unknown) => {
  const value = (body as Record<string, unknown> | null)?.[key]
  return Array.isArray(value) ? value as T[] : undefined
}

/** A group chat the person is in, with its latest message (GET /api/conversations). */
export type GroupSummary = { id: string; workspaceId: string; title: string; createdAt: string; lastMessage: GroupMessage | null }

/** The person's group chats in one workspace, for the bot list (R-01). */
export function fetchGroups(workspaceId: string, fetcher: typeof fetch = fetch): Promise<GroupSummary[]> {
  return readGroupApi(`/api/conversations?${new URLSearchParams({ workspaceId })}`, listIn<GroupSummary>('conversations'), fetcher)
}

/** A group's members as GET /api/conversations/{id}/members returns them; bots carry their colour and shape. */
export type GroupMember = { id: string; name: string; memberType: 'user' | 'agent' | 'bot'; color?: string | null; shape?: string | null }

export function fetchGroupMembers(id: string, fetcher: typeof fetch = fetch): Promise<GroupMember[]> {
  return readGroupApi(`/api/conversations/${encodeURIComponent(id)}/members`, listIn<GroupMember>('members'), fetcher)
}
