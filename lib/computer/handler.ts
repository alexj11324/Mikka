import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createBotSchema, viewerRequestSchema } from '@mikka/protocol/computer'
import { ComputerError, type ComputerStore } from './store'

export function createComputerHandler(store: Pick<ComputerStore, 'listBots' | 'createBot' | 'state' | 'operate'>, authenticate: (request: Request) => Promise<{ userId: string; workspaceId: string } | null>, wakeWorker?: (actor: { userId: string; workspaceId: string }, botId: string) => Promise<void>) {
  return async function computerRoute(request: Request, botId?: string, action?: 'wake' | 'viewer' | 'takeover' | 'handback') {
    const response = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
    try {
      const actor = await authenticate(request)
      if (!actor) return response({ error: 'Sign in required' }, 401)
      if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) return response({ error: 'Invalid origin' }, 403)
      if (!botId) {
        if (request.method === 'GET') return response(await store.listBots(actor))
        const { name } = createBotSchema.parse(await request.json())
        return response(await store.createBot(actor, name), 201)
      }
      z.uuid().parse(botId)
      if (!action) return response(await store.state(actor, botId))
      const mode = action === 'viewer' ? viewerRequestSchema.parse(await request.json()).mode : 'view'
      const result = await store.operate(actor, botId, action, mode)
      // Provision after operate commits: worker provisioning takes its own
      // machine lease and must not wait on the desktop transaction's row lock.
      if (action === 'wake' && wakeWorker) await wakeWorker(actor, botId)
      return response(result, action === 'wake' ? 202 : 200)
    } catch (error) {
      if (error instanceof ComputerError) return response({ error: error.message }, error.status)
      if (error instanceof z.ZodError || error instanceof SyntaxError) return response({ error: 'Invalid request' }, 400)
      // Provider errors may contain request URLs or headers. Never serialize them.
      return response({ error: 'Cloud computer is unavailable' }, 503)
    }
  }
}
