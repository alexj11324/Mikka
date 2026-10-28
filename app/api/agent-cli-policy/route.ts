import { z } from 'zod'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { readCliRunPolicy } from '@/lib/agent-tool-approval/policy-store'
import { setCliPolicy } from '@/lib/agent-tool-approval/policy-settings'

export const dynamic = 'force-dynamic'
const schema = z.discriminatedUnion('operation', [
  z.object({ operation:z.literal('read'), runId:z.uuid() }).strict(),
  z.object({ operation:z.literal('set'), runId:z.uuid(), target:z.enum(['agent','worker','workspace']), expectedRevision:z.string().regex(/^[a-f0-9]{64}$/), policy:z.unknown() }).strict(),
])
export async function POST(request: Request) {
  if (!request.headers.get('cookie') || request.headers.has('authorization') || request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error:'unauthorized' }, { status:401 })
  const session = await auth.api.getSession({ headers:request.headers, query:{ disableCookieCache:true } })
  if (!session?.user) return Response.json({ error:'unauthorized' }, { status:401 })
  const result = schema.safeParse(await request.json().catch(() => null))
  if (!result.success) return Response.json({ error:'invalidRequest' }, { status:400 })
  const body = result.data
  try {
    const value = body.operation === 'read' ? await readCliRunPolicy(pool,body.runId,session.user.id) : await setCliPolicy(pool,session.user.id,body.runId,body.target,body.expectedRevision,body.policy)
    return Response.json(value, { headers:{ 'cache-control':'no-store' } })
  } catch { return Response.json({ error:'agentPolicyUnavailable' }, { status:409 }) }
}
