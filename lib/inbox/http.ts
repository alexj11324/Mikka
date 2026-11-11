import { inboxCommand, inboxQuery, InboxError } from './contract'
import type { InboxReader, InboxStore } from './store'
import { tokenWorkspace } from '@/lib/tokens/principal'

const headers = { 'Cache-Control': 'private, no-store' }
export async function handleInbox(request: Request, user: Exclude<InboxReader, string> | null, store: Pick<InboxStore, 'list' | 'command'>) {
  if (!user) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  try {
    if (request.method === 'GET') {
      const parsed = inboxQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams))
      if (!parsed.success) throw new InboxError('inboxInvalid', 422)
      const q = parsed.data
      if (user[tokenWorkspace] && user[tokenWorkspace] !== q.workspaceId) throw new InboxError('workspaceAccessDenied', 403)
      const result = await store.list(user, q.workspaceId, q.tab, q.limit, q.cursor)
      return Response.json({ ...result, live: { workspaceId: q.workspaceId, keys: ['issue_list', 'pending_actions', 'thread_list', 'task_run_list', 'bot_chat_list', 'bot_chat', 'factory_task'] }, historyBackfilled: false }, { headers })
    }
    if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'originNotAllowed' }, { status: 403, headers })
    const reader = request.body?.getReader()
    if (!reader) throw new InboxError('inboxInvalid', 422)
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 4096) { await reader.cancel(); throw new InboxError('inboxInvalid', 422) }
        chunks.push(chunk.value)
      }
    } finally { reader.releaseLock() }
    const text = Buffer.concat(chunks).toString('utf8')
    let body: unknown
    try { body = JSON.parse(text) } catch (error) { throw new InboxError('inboxInvalid', 422, { cause: error }) }
    const parsed = inboxCommand.safeParse(body)
    if (!parsed.success) throw new InboxError('inboxInvalid', 422)
    if (user[tokenWorkspace] && user[tokenWorkspace] !== parsed.data.workspaceId) throw new InboxError('workspaceAccessDenied', 403)
    return Response.json(await store.command(user, parsed.data), { headers })
  } catch (error) {
    if (!(error instanceof InboxError)) throw error
    return Response.json({ error: error.code }, { status: error.status, headers })
  }
}
