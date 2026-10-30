import 'server-only'
import { after, NextResponse } from 'next/server'
import { z } from 'zod'
import { start } from 'workflow/api'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ComputerError } from '@/lib/computer/store'
import { startSubagentSchema } from '@mikka/protocol/subagent'
import { SubagentStore } from './subagents'
import { webSubagentWorkflow } from '@/workflows/subagent/workflow'
const headers = { 'Cache-Control': 'private, no-store' }
export async function subagentRoute(request: Request, botId: string, id?: string, action?: 'viewer' | 'stop') {
  const response = (body: unknown, status = 200) => NextResponse.json(body, { status, headers })
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return response({ error: 'authRequired' }, 401)
    if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) return response({ error: 'Invalid origin' }, 403)
    z.uuid().parse(botId); if (id) z.uuid().parse(id)
    const context = await loadWorkspaceContext(undefined, session.user)
    const actor = { userId: session.user.id, workspaceId: context.workspace.id }
    const store = new SubagentStore(pool)
    if (!id) {
      const { task } = startSubagentSchema.parse(await request.json())
      const row = await store.create(actor, botId, task)
      after(() => start(webSubagentWorkflow, [actor, botId, row.id]).then(() => undefined))
      return response({ subagentId: row.id, state: row.status }, 202)
    }
    if (action === 'viewer') return response(await store.viewer(actor, botId, id))
    if (action === 'stop') { const row = await store.stop(actor, botId, id); return response({ subagentId: row.id, state: row.status }) }
    const row = await store.get(actor, botId, id)
    const approval = (await pool.query(`SELECT id,input->>'summary' AS summary,created_at FROM (SELECT id,input,"createdAt" AS created_at FROM pending_actions WHERE "userId"=$2 AND action='browser_operation' AND status='pending' AND input->>'subagentId'=$1 AND "createdAt">now()-interval '5 minutes') p ORDER BY created_at DESC LIMIT 1`, [id, actor.userId])).rows[0] ?? null
    return response({ subagentId: row.id, botId: row.botId, task: row.task, state: row.status, step: row.step, needs: row.needs, approval })
  } catch (error) {
    if (error instanceof ComputerError) return response({ error: error.message }, error.status)
    if (error instanceof z.ZodError || error instanceof SyntaxError) return response({ error: 'Invalid request' }, 400)
    return response({ error: 'Browser runtime unavailable' }, 503)
  }
}
