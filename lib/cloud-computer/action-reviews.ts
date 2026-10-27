import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { ComputerError } from '@/lib/computer/store'
import { SubagentStore, type Actor } from './subagents'
export const browserMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), selector: z.string().min(1).max(500) }).strict(),
  z.object({ action: z.literal('type'), selector: z.string().min(1).max(500), text: z.string().max(2000) }).strict(),
  z.object({ action: z.literal('key'), key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp']) }).strict(),
])
export type BrowserMutation = z.infer<typeof browserMutationSchema>
const approvedSchema = z.object({ workspaceId: z.uuid(), botId: z.uuid(), subagentId: z.uuid(), epoch: z.number().int(), loaderId: z.string(), origin: z.string(), mutation: browserMutationSchema, summary: z.string().max(500), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
/** Reuse the existing pending_actions ledger and decidePendingAction server
 * action. No subagent run, replacement permission system or new UI is created. */
export async function browserAction(pool: Pool, actor: Actor, botId: string, id: string, mutation: BrowserMutation, summary: string, irreversible: boolean) {
  const store = new SubagentStore(pool)
  const row = await store.get(actor, botId, id)
  if (row.status !== 'running') throw new ComputerError(409, 'Subagent is waiting')
  const action = browserMutationSchema.parse(mutation)
  const check = await store.action(actor, botId, id, { action: 'inspectMutation', mutation: action })
  if (!irreversible && !check.requiresApproval) return { state: 'running', ...await store.action(actor, botId, id, action) }
  const input = { workspaceId: actor.workspaceId, botId, subagentId: id, epoch: row.epoch, loaderId: String(check.loaderId), origin: String(check.origin), mutation: action, summary: summary.slice(0, 500) }
  const digest = createHash('sha256').update(JSON.stringify([actor.userId, input])).digest('hex')
  const reviewId = randomUUID()
  await pool.query(`INSERT INTO pending_actions (id,"userId",action,input) VALUES ($1,$2,'browser_operation',$3)`, [reviewId, actor.userId, JSON.stringify({ ...input, digest })])
  await store.update(actor, botId, id, 'needs_you', 'approval')
  return { state: 'needs_you', actionId: reviewId, digest, summary: input.summary }
}
/** Called only after the existing ledger has atomically consumed pending ->
 * running. It cannot replay, alter the operation, or act on a navigated page. */
export async function executeApprovedBrowserAction(pool: Pool, userId: string, raw: unknown, approved: boolean): Promise<{ data: Record<string, unknown> } | { error: string }> {
  let active: { store: SubagentStore; actor: Actor; botId: string; id: string } | undefined
  try {
    const input = approvedSchema.parse(raw)
    const { digest, ...signed } = input
    if (createHash('sha256').update(JSON.stringify([userId, signed])).digest('hex') !== digest) return { error: 'browserActionChanged' }
    const { authorizeSubscriptionWorkspace } = await import('@/lib/subscription-runtime')
    await authorizeSubscriptionWorkspace(userId, input.workspaceId)
    const actor = { userId, workspaceId: input.workspaceId }
    const store = new SubagentStore(pool)
    const row = await store.get(actor, input.botId, input.subagentId)
    if (row.status !== 'needs_you' || row.epoch !== input.epoch) return { error: 'browserActionExpired' }
    if (!approved) { await store.stop(actor, input.botId, input.subagentId); return { data: {} } }
    active = { store, actor, botId: input.botId, id: input.subagentId }
    await store.update(actor, input.botId, input.subagentId, 'running', input.summary)
    await store.action(actor, input.botId, input.subagentId, { ...input.mutation, expectedLoaderId: input.loaderId, expectedOrigin: input.origin })
    return { data: { subagentId: input.subagentId } }
  } catch {
    if (active) await active.store.update(active.actor, active.botId, active.id, 'failed', 'Action outcome unknown').catch(() => undefined)
    return { error: 'browserActionOutcomeUnknown' }
  }
}
