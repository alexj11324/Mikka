import { z } from 'zod'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { subscriptionRuntime } from '@/lib/subscription-runtime'

const inputSchema = z.object({ connectionId: z.uuid(), revision: z.number().int().positive(), harness: z.enum(['codex', 'claude_code']), modelId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict()
const headers = { 'Cache-Control': 'private, no-store' }
export async function POST(request: Request, { params }: { params: Promise<{ botId: string }> }) {
  if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1' || process.env.MIKKA_BYOS_ENABLED !== '1') return Response.json({ error: 'Cloud computer task unavailable' }, { status: 503, headers })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'Sign in required' }, { status: 401, headers })
  if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Invalid origin' }, { status: 403, headers })
  const { botId } = await params
  const raw = await request.text()
  if (raw.length > 2000 || !z.uuid().safeParse(botId).success) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
  const parsed = inputSchema.safeParse((() => { try { return JSON.parse(raw) } catch { return null } })())
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
  try {
    const context = await loadWorkspaceContext(undefined, session.user)
    const runtime = (await pool.query('SELECT "agentId" FROM bot_cloud_runtimes WHERE "botId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND harness=$4', [botId, session.user.id, context.workspace.id, parsed.data.harness])).rows[0]
    if (!runtime) return Response.json({ error: 'Bot computer task is unavailable' }, { status: 409, headers })
    const route = parsed.data.harness === 'codex' ? 'codex_cli' : 'claude_code_cli'
    const bindingId = await subscriptionRuntime().repository.bind(session.user.id, context.workspace.id, runtime.agentId, parsed.data.connectionId, parsed.data.revision, route, parsed.data.modelId)
    return Response.json({ bindingId }, { headers })
  } catch { return Response.json({ error: 'Subscription unavailable' }, { status: 409, headers }) }
}
