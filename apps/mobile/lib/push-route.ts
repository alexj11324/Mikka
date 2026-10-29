const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const id = (value: unknown) => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null

/**
 * Where a tapped push opens, from its `data` (lib/mobile-push.ts on the
 * server): a proposal waiting for the person opens its chat scrolled to that
 * card; a finished thread opens the thread; anything else opens the chat it
 * came from. Fields the server does not send yet are simply absent.
 */
export function pushTarget(data: unknown): string {
  const fields = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const bot = id(fields.botId)
  const chat = bot ? `/bots/${bot}` : '/'
  const action = id(fields.pendingActionId)
  if (action) return `${chat}?action=${action}`
  const run = id(fields.runId)
  if (run) return `/threads/${run}`
  return chat
}
