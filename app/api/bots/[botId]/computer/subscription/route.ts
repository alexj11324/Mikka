import { cloudComputerTasksEnabled } from '@/lib/cloud-computer-flag'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { bindBotSubscription } from '@/lib/computer/bot-subscription'

const inputSchema = z.object({ connectionId: z.uuid(), revision: z.number().int().positive(), harness: z.enum(['codex', 'claude_code']), modelId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict()
const headers = { 'Cache-Control': 'private, no-store' }
export async function POST(request: Request, { params }: { params: Promise<{ botId: string }> }) {
  if (!cloudComputerTasksEnabled() || process.env.MIKKA_BYOS_ENABLED !== '1') return Response.json({ error: 'Cloud computer task unavailable' }, { status: 503, headers })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'Sign in required' }, { status: 401, headers })
  if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Invalid origin' }, { status: 403, headers })
  const { botId } = await params
  const requestId = request.headers.get('idempotency-key')
  const raw = await request.text()
  if (raw.length > 2000 || !z.uuid().safeParse(botId).success || (requestId && !z.uuid().safeParse(requestId).success)) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
  const parsed = inputSchema.safeParse((() => { try { return JSON.parse(raw) } catch { return null } })())
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
  try {
    const context = await loadWorkspaceContext(undefined, session.user)
    const result = await bindBotSubscription(pool, { userId: session.user.id, workspaceId: context.workspace.id }, { ...parsed.data, botId, ...(requestId ? { idempotencyKey: `api:${requestId}` } : {}) })
    return Response.json(result, { headers })
  } catch { return Response.json({ error: 'Subscription unavailable' }, { status: 409, headers }) }
}
