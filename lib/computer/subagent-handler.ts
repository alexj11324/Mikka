import { z } from 'zod'
import { viewerRequestSchema } from '@mikka/protocol/computer'
import { ComputerError } from './store'
import type { SubagentStore } from './subagent-store'

export function createSubagentHandler(store: Pick<SubagentStore, 'operate'>, authenticate: (request: Request) => Promise<{ userId: string; workspaceId: string } | null>) {
  return async (request: Request, botId: string, id: string, action: 'viewer' | 'takeover' | 'handback' | 'stop') => {
    const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
    try {
      const actor = await authenticate(request)
      if (!actor) return response({ error: 'Sign in required' }, 401)
      if (request.method !== 'POST' || request.headers.get('origin') !== new URL(request.url).origin) return response({ error: 'Invalid origin' }, 403)
      z.uuid().parse(botId); z.uuid().parse(id)
      const mode = action === 'viewer' ? viewerRequestSchema.parse(await request.json()).mode : 'view'
      return response(await store.operate(actor, botId, id, action, mode))
    } catch (error) {
      if (error instanceof ComputerError) return response({ error: error.message }, error.status)
      if (error instanceof z.ZodError || error instanceof SyntaxError) return response({ error: 'Invalid request' }, 400)
      return response({ error: 'Web task is unavailable' }, 503)
    }
  }
}
