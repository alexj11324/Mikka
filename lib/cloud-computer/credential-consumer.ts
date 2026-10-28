import 'server-only'
import { ComputerError } from '@/lib/computer/store'
import type { Actor } from './subagents'

/** #345 must validate owner, origin, loader, backend node identity against the
 * live bound target/session, and secret isolation. The node ID is an observed
 * CDP identity, not code and not authority. The host must apply and consume
 * computer_use before any action.
 * The model supplies neither credentials nor a permission decision. */
export async function executeCredentialIntent(_input: { permissionAction: 'computer_use'; actor: Actor; botId: string; subagentId: string; epoch: number; loaderId: string; origin: string; backendNodeId: number; intent: { targetSelector: string; role: 'username' | 'password' } }): Promise<{ status: 'needs_login' | 'session_applied' | 'submitted' } | { status: 'needs_you'; actionId: string; summary: string }> {
  throw new ComputerError(503, 'Credential action authority unavailable')
}
