import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ComputerError, ComputerStore } from './store'

const store = new ComputerStore(pool)
export async function computerRoute(request: Request, botId?: string, action?: 'wake' | 'viewer' | 'takeover' | 'handback') {
  const response = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return response({ error: 'Sign in required' }, 401)
    if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) return response({ error: 'Invalid origin' }, 403)
    const context = await loadWorkspaceContext(undefined, session.user)
    const actor = { userId: session.user.id, workspaceId: context.workspace.id }
    if (!botId) {
      if (request.method === 'GET') return response(await store.listBots(actor))
      const { name } = z.object({ name: z.string().trim().min(1).max(120) }).strict().parse(await request.json())
      return response(await store.createBot(actor, name), 201)
    }
    z.uuid().parse(botId)
    if (!action) return response(await store.state(actor, botId))
    const mode = action === 'viewer' ? z.object({ mode: z.enum(['view', 'control']) }).strict().parse(await request.json()).mode : 'view'
    const result = await store.operate(actor, botId, action, mode)
    return response(result, action === 'wake' ? 202 : 200)
  } catch (error) {
    if (error instanceof ComputerError) return response({ error: error.message }, error.status)
    if (error instanceof z.ZodError || error instanceof SyntaxError) return response({ error: 'Invalid request' }, 400)
    // Provider errors may contain request URLs or headers. Never serialize them.
    return response({ error: 'Cloud computer is unavailable' }, 503)
  }
}
