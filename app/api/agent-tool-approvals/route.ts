import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { AgentToolApprovalStore } from '@/lib/agent-tool-approval/store'

export const dynamic = 'force-dynamic'
const requestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list'), runId: z.uuid() }).strict(),
  z.object({ operation: z.literal('decide'), runId: z.uuid(), id: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['approve','deny']) }).strict(),
])
export async function POST(request: Request) {
  if (!request.headers.get('cookie') || request.headers.has('authorization') || request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session?.user) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'invalidRequest' }, { status: 400 })
  const value = parsed.data; const store = new AgentToolApprovalStore(pool)
  try {
    return Response.json(value.operation === 'list' ? { requests: await store.list(session.user.id, value.runId) } : await store.decide(session.user.id, value.runId, value.id, value.digest, value.decision, { name: session.user.name || session.user.id }), { headers: { 'cache-control': 'no-store' } })
  } catch { return Response.json({ error: 'approvalUnavailable' }, { status: 409 }) }
}
