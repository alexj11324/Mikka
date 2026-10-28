import 'server-only'
import { browserActionDigest } from './browser-action-receipt'
import type { Pool } from 'pg'
import { z } from 'zod'
import { ComputerError } from '@/lib/computer/store'
import { SubagentStore, type Actor } from './subagents'
import { authorizeBrowserAction, executeAuthorizedBrowserAction, executeReviewedBrowserAction } from './browser-authority'
export const browserMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), selector: z.string().min(1).max(500) }).strict(),
  z.object({ action: z.literal('type'), selector: z.string().min(1).max(500), text: z.string().max(2000) }).strict(),
  z.object({ action: z.literal('key'), key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp']) }).strict(),
  z.object({ action: z.literal('navigate'), url: z.url().refine(value => { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password }) }).strict(),
])
export type BrowserMutation = z.infer<typeof browserMutationSchema>
const approvedSchema = z.object({ actionId: z.uuid(), workspaceId: z.uuid(), botId: z.uuid(), subagentId: z.uuid(), epoch: z.number().int(), policyVersion: z.number().int().nonnegative(), expiresAt: z.number().finite(), loaderId: z.string(), origin: z.string(), mutation: browserMutationSchema, summary: z.string().max(500), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
/** Reuse the existing pending_actions ledger and decidePendingAction server
 * action. No subagent run, replacement permission system or new UI is created. */
export async function browserAction(pool: Pool, actor: Actor, botId: string, id: string, mutation: BrowserMutation, summary: string) {
  const store = new SubagentStore(pool)
  const row = await store.get(actor, botId, id)
  if (row.status !== 'running') throw new ComputerError(409, 'Subagent is waiting')
  const action = browserMutationSchema.parse(mutation)
  const check = await store.action(actor, botId, id, { action: 'inspectMutation', mutation: action })
  if (typeof check.loaderId !== 'string' || !check.loaderId || typeof check.origin !== 'string' || !check.origin) throw new ComputerError(503, 'Browser target unavailable')
  const decision = await authorizeBrowserAction({ permissionAction: 'computer_use', actor, botId, subagentId: id, epoch: row.epoch, loaderId: check.loaderId, origin: check.origin, mutation: action, summary: summary.slice(0, 500) })
  if (!Number.isSafeInteger(decision.policyVersion) || decision.policyVersion < 0 || !Number.isFinite(decision.expiresAt) || decision.expiresAt <= Date.now()) throw new ComputerError(403, 'Browser authorization expired')
  if (decision.readOnly || decision.decision === 'deny') throw new ComputerError(403, 'Browser action denied')
  if (decision.decision === 'allow') return { ...await executeAuthorizedBrowserAction({ actor, botId, subagentId: id, epoch: row.epoch, actionId: decision.review!.actionId, digest: decision.review!.digest, policyVersion: decision.policyVersion, expiresAt: decision.expiresAt, loaderId: check.loaderId, origin: check.origin, mutation: action }), state: 'running' as const }
  if (decision.decision !== 'ask') throw new ComputerError(503, 'Browser action authority unavailable')
  // `ask` must reuse the authority's exact pending request. Creating a second
  // independent pending action would require the same operation to be approved
  // twice and would not prove the broker's grant was consumed.
  const review = z.object({ actionId: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), summary: z.string().max(500) }).strict().parse(decision.review)
  await store.update(actor, botId, id, 'needs_you', 'approval', { kind: 'approval', actionId: review.actionId, summary: review.summary })
  return { state: 'needs_you' as const, ...review }
}
/** Called only after the existing ledger has atomically consumed pending ->
 * running. It cannot replay, alter the operation, or act on a navigated page. */
export async function executeApprovedBrowserAction(pool: Pool, userId: string, raw: unknown, approved: boolean, receiptId?: string): Promise<{ data: Record<string, unknown> } | { error: string }> {
  if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'browser_credential') {
    const { executeApprovedCredentialAction } = await import('./credential-consumer')
    return executeApprovedCredentialAction(pool, userId, raw, approved, receiptId)
  }
  let active: { store: SubagentStore; actor: Actor; botId: string; id: string } | undefined
  try {
    const input = approvedSchema.parse(raw)
    if (input.actionId !== receiptId) return { error: 'browserActionChanged' }
    const { digest, ...signed } = input
    if (browserActionDigest(userId, signed) !== digest) return { error: 'browserActionChanged' }
    const { authorizeSubscriptionWorkspace } = await import('@/lib/subscription-runtime')
    await authorizeSubscriptionWorkspace(userId, input.workspaceId)
    const actor = { userId, workspaceId: input.workspaceId }
    const store = new SubagentStore(pool)
    const row = await store.get(actor, input.botId, input.subagentId)
    if (row.status !== 'needs_you' || row.epoch !== input.epoch || row.needs?.kind !== 'approval' || row.needs.actionId !== input.actionId) return { error: 'browserActionExpired' }
    if (!approved) { await store.stop(actor, input.botId, input.subagentId); return { data: {} } }
    if (input.expiresAt <= Date.now()) return { error: 'browserActionExpired' }
    active = { store, actor, botId: input.botId, id: input.subagentId }
    await executeReviewedBrowserAction({ actor, botId: input.botId, subagentId: input.subagentId, epoch: input.epoch, actionId: input.actionId, policyVersion: input.policyVersion, expiresAt: input.expiresAt, loaderId: input.loaderId, origin: input.origin, mutation: input.mutation, digest })
    await store.update(actor, input.botId, input.subagentId, 'running', input.summary)
    return { data: { subagentId: input.subagentId } }
  } catch {
    if (active) await active.store.update(active.actor, active.botId, active.id, 'failed', 'Action outcome unknown').catch(() => undefined)
    return { error: 'browserActionOutcomeUnknown' }
  }
}
