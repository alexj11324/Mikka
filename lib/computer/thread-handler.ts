import { z } from 'zod'
import { viewerRequestSchema } from '@mikka/protocol/computer'
import { ComputerError } from './store'
import type { ThreadDesktopStore } from './thread-desktop'

export function createThreadComputerHandler(store: Pick<ThreadDesktopStore, 'state' | 'operate'>, authenticate: (request: Request) => Promise<{ userId: string; workspaceId: string } | null>) {
  return async (request: Request, runId: string, action?: 'wake' | 'viewer' | 'takeover' | 'handback') => {
    const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
    try {
      const actor = await authenticate(request)
      if (!actor) return response({ error: 'Sign in required' }, 401)
      if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) return response({ error: 'Invalid origin' }, 403)
      z.uuid().parse(runId)
      if (!action) return response(await store.state(actor, runId))
      const mode = action === 'viewer' ? viewerRequestSchema.parse(await request.json()).mode : 'view'
      const result = await store.operate(actor, runId, action, mode)
      return response(result, action === 'wake' ? 202 : 200)
    } catch (error) {
      if (error instanceof ComputerError) return response({ error: error.message }, error.status)
      if (error instanceof z.ZodError || error instanceof SyntaxError) return response({ error: 'Invalid request' }, 400)
      return response({ error: 'Cloud computer is unavailable' }, 503)
    }
  }
}
