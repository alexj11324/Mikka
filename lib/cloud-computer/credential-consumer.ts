import 'server-only'
import { ComputerError } from '@/lib/computer/store'
import type { Actor } from './subagents'
import type { CredentialIntent } from './credential-intent'

/** #345 must validate owner, origin, exact live element, session, and secret
 * isolation. The host must apply and consume computer_use before any action.
 * The model supplies neither credentials nor a permission decision. */
export async function executeCredentialIntent(_input: { permissionAction: 'computer_use'; actor: Actor; botId: string; subagentId: string; epoch: number; loaderId: string; origin: string; intent: CredentialIntent }): Promise<{ status: 'needs_login' | 'session_applied' | 'submitted' } | { status: 'needs_you'; actionId: string; summary: string }> {
  throw new ComputerError(503, 'Credential action authority unavailable')
}
