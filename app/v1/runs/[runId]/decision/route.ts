import { withDeviceRoute } from '@/lib/device-route'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { authenticateDevice } from '@/lib/device-link'
import { decide } from '@/lib/coordinator/decide'

type ServerDecisionAnswer = { type: 'predicate'; name: string; probability: number } | { type: 'choice'; name: string; choice: string }
export const dynamic = 'force-dynamic'
const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
const instructions = z.string().min(1).max(4000)
const payload = z.object({
  purpose: z.enum(['command-action', 'network-destination', 'computer-action', 'tool-access', 'setup-recipe', 'permission-default']),
  input: z.string().max(16000),
  questions: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('predicate'), name, instructions }).strict(),
    z.object({ type: z.literal('choice'), name, instructions, choices: z.array(z.object({ value: z.string().min(1).max(256), description: z.string().max(1000).optional() }).strict()).min(1).max(20) }).strict(),
  ])).min(1).max(20),
}).strict()

/** A daemon run asks the server's Decisions API (packages/daemon/src/server-decision.ts). */
async function handlePOST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const { runId } = await params
  const parsed = payload.safeParse(await request.json().catch(() => null))
  if (!z.uuid().safeParse(runId).success || !parsed.success) return Response.json({ error: 'invalidRequest' }, { status: 400 })
  // Same liveness as tool approval: the caller's own unpaused, unstopped, leased run on its enabled device.
  const { rows: [run] } = await pool.query<{ botId: string | null }>(`SELECT r."botId" FROM agent_runs r JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId" AND d.enabled=true
    WHERE r.id=$1 AND r."userId"=$2 AND ($3::uuid IS NULL OR r."deviceId"=$3::uuid) AND r.status=ANY($4::text[]) AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now()`,
  [runId, caller.userId, caller.scopeDeviceId ?? null, ['preparing', 'running', 'waiting_input']])
  if (!run) return Response.json({ error: 'decisionUnavailable' }, { status: 409 })
  const { purpose, input, questions } = parsed.data
  const { hostedBillingScope } = await import('@/lib/abuse/context')
  const { executionWorkspace } = await import('@/lib/execution-settings')
  let answers: Awaited<ReturnType<typeof decide>> = null
  try { answers = await hostedBillingScope.run({ workspaceId: await executionWorkspace(caller.userId, run.botId), ownerId: caller.userId }, () => decide(`daemon-${purpose}`, input, questions, request.signal)) } catch { answers = null }
  if (!answers) return Response.json({ answers: null })
  return Response.json({ answers: [...answers.values()].flatMap((answer): ServerDecisionAnswer[] => answer.type === 'predicate' ? [{ type: answer.type, name: answer.name, probability: answer.probability }]
    : answer.type === 'choice' ? [{ type: answer.type, name: answer.name, choice: answer.choice }] : []) })
}

export const POST = withDeviceRoute(handlePOST)
