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
      let result
      try {
        result = await store.operate(actor, botId, action, mode)
      } catch (error) {
        if (action === 'wake' && error instanceof ComputerError && error.status === 409 && error.message === 'Computer provisioning in progress') return response(null, 202)
        throw error
      }
      // Provision after operate commits: worker provisioning takes its own
      // machine lease and must not wait on the desktop transaction's row lock.
      if (action === 'wake' && wakeWorker) await wakeWorker(actor, botId)
      return response(result, action === 'wake' ? 202 : 200)
    } catch (error) {
      if (error instanceof ComputerError) return response({ error: error.message }, error.status)
      if (error instanceof z.ZodError || error instanceof SyntaxError) return response({ error: 'Invalid request' }, 400)
      // Provider errors may contain request URLs or headers. Never serialize them: the log
      // gets a fixed code (or the error's class name) and the sandbox id, the response neither.
      console.error(JSON.stringify({ event: 'cloud_computer_failed', action: action ?? null, botId: botId ?? null, ...failure(error) }))
      return response({ error: 'Cloud computer is unavailable' }, 503)
    }
  }
}

function failure(error: unknown) {
  const { code, sandboxId, name } = (error && typeof error === 'object' ? error : {}) as { code?: unknown; sandboxId?: unknown; name?: unknown }
  return {
    code: typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : typeof name === 'string' && /^\w{1,64}$/.test(name) ? name : 'unknown',
    ...(typeof sandboxId === 'string' && /^[a-z0-9]{1,64}$/.test(sandboxId) ? { sandboxId } : {}),
  }
}
