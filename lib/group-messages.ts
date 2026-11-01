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
export type GroupMessagePage = { messages: GroupMessage[]; nextBefore: string | null }
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

/** One member from GET /api/conversations/{id}/members: a person, or a bot or agent with its look. */
export type GroupMember = {
  id: string
  name: string
  memberType: 'user' | 'agent' | 'bot'
  avatarUrl?: string | null
  role?: string
  color?: string
  shape?: string
}

export function groupMembersUrl(id: string) {
  return withBasePath(`/api/conversations/${encodeURIComponent(id)}/members`)
}

/** The group's current members (R-13 详情): people first, then bots and agents. Same errors as the message pages. */
export async function fetchGroupMembers(id: string, fetcher: typeof fetch = fetch): Promise<GroupMember[]> {
  let response: Response
  try { response = await fetcher(groupMembersUrl(id), { cache: 'no-store', credentials: 'same-origin' }) }
  catch { throw new GroupMessagesRequestError('unavailable') }
  const body = await response.json().catch(() => null) as { members?: GroupMember[] } | null
  if (response.ok && body && Array.isArray(body.members)) return body.members
  throw new GroupMessagesRequestError(response.status === 401 ? 'unauthorized' : response.status === 404 ? 'not_found' : 'unavailable')
}
