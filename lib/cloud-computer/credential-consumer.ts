import 'server-only'
import type { Pool } from 'pg'
import { ComputerError } from '@/lib/computer/store'
import type { Actor } from './subagents'
import { parseCredentialAction, type CredentialAction } from './credential-action-ledger'

/** #345 must validate owner, origin, loader, backend node identity against the
 * live bound target/session, and secret isolation. The node ID is an observed
 * CDP identity, not code and not authority. The host must apply and consume
 * computer_use before any action.
 * The model supplies neither credentials nor a permission decision. */
export async function executeCredentialIntent(_input: { permissionAction: 'computer_use'; actor: Actor; botId: string; subagentId: string; epoch: number; targetId: string; loaderId: string; origin: string; backendNodeId: number; intent: { targetSelector: string; role: 'username' | 'password' } }): Promise<{ status: 'needs_login' | 'session_applied' | 'submitted' | 'guarded' } | { status: 'needs_you'; actionId: string; summary: string }> {
  throw new ComputerError(503, 'Credential action authority unavailable')
}

/** Called only by the existing pending action dispatcher after its atomic
 * pending -> running/declined transition; approval is never model supplied. */
export async function executeApprovedCredentialAction(pool: Pool, userId: string, raw: unknown, approved: boolean, receiptId?: string): Promise<{ data: Record<string, unknown> } | { error: string }> {
  try {
    const action = parseCredentialAction(raw as CredentialAction)
    if (action.userId !== userId || action.actionId !== receiptId || action.admission !== 'ask') return { error: 'browserActionChanged' }
    const { authorizeSubscriptionWorkspace } = await import('@/lib/subscription-runtime')
    await authorizeSubscriptionWorkspace(userId, action.workspaceId)
    const { SubagentStore } = await import('./subagents')
    const store = new SubagentStore(pool)
    const actor = { userId, workspaceId: action.workspaceId }
    const row = await store.get(actor, action.botId, action.subagentId)
    if (row.status !== 'needs_you' || row.epoch !== action.epoch || row.targetId !== action.targetId || row.needs?.kind !== 'approval' || row.needs.actionId !== action.actionId) return { error: 'browserActionExpired' }
    if (!approved) { await store.stop(actor, action.botId, action.subagentId); return { data: {} } }
    // The service must consume this exact running record and recheck current
    // permission and target under its own I/O lock. Never self-certify it here.
    return { error: 'browserCredentialServiceUnavailable' }
  } catch { return { error: 'browserActionOutcomeUnknown' } }
}
