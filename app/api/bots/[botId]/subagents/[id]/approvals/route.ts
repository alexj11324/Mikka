import { z } from 'zod'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { SubagentApprovals } from '@/lib/computer/subagent-approval'

export const runtime = 'nodejs'
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
const approval = z.object({ id: z.uuid(), digest: z.string().regex(/^[0-9a-f]{64}$/), approve: z.boolean() }).strict()

async function actor(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return null
  const context = await loadWorkspaceContext(undefined, session.user)
  return { userId: session.user.id, workspaceId: context.workspace.id }
}

export async function GET(request: Request, context: { params: Promise<{ botId: string; id: string }> }) {
  const identity = await actor(request)
  if (!identity) return response({ error: 'Sign in required' }, 401)
  const { botId, id } = await context.params
  if (!z.uuid().safeParse(botId).success || !z.uuid().safeParse(id).success) return response({ error: 'Invalid request' }, 400)
  return response({ approval: await new SubagentApprovals(pool).pending(identity, botId, id) })
}

export async function POST(request: Request, context: { params: Promise<{ botId: string; id: string }> }) {
  const identity = await actor(request)
  if (!identity) return response({ error: 'Sign in required' }, 401)
  if (request.headers.get('origin') !== new URL(request.url).origin) return response({ error: 'Invalid origin' }, 403)
  const { botId, id } = await context.params
  const body = approval.safeParse(await request.json().catch(() => null))
  if (!z.uuid().safeParse(botId).success || !z.uuid().safeParse(id).success || !body.success) return response({ error: 'Invalid request' }, 400)
  const accepted = await new SubagentApprovals(pool).decide(identity, botId, id, body.data.id, body.data.digest, body.data.approve)
  return accepted ? response({ accepted: true }) : response({ error: 'Approval is no longer available' }, 409)
}
