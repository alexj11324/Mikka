const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const id = (value: unknown) => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null

/** A notification is never interpreted under another server/account. */
export function pushBelongsToAccount(data: unknown, account: { id: string; server: { url: string }; user: { id: string } | null }): boolean {
  if (!account.user || !data || typeof data !== 'object') return false
  const fields = data as Record<string, unknown>
  if (fields.serverUrl === undefined && fields.userId === undefined) return account.id === 'legacy' && account.server.url === 'https://app.aspectlylabs.com/mikka'
  return fields.serverUrl === account.server.url && fields.userId === account.user.id
}

/**
 * Where a tapped push opens, from its `data` (lib/mobile-push.ts on the
 * server): a proposal waiting for the person opens its chat scrolled to that
 * card; a finished thread opens the thread; anything else opens the chat it
 * came from. Fields the server does not send yet are simply absent.
 */
export function pushTarget(data: unknown): string {
  const fields = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const bot = id(fields.botId)
  const chat = `/bots/${bot ?? 'coordinator'}`
  const action = id(fields.pendingActionId)
  if (action) return `${chat}?action=${action}`
  const run = id(fields.runId)
  if (run) return `/thread/${run}`
  return chat
}
