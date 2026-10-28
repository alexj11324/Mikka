import 'server-only'
import { ComputerError } from '@/lib/computer/store'
import type { Actor } from './subagents'
import type { BrowserMutation } from './action-reviews'

/** Consumer boundary for the trusted host policy. The authoritative host
 * assignment and its atomic grant consumption have not been delivered here.
 * Do not substitute a model flag or workspace access for this decision. */
export type BrowserAuthority = { decision: 'allow' | 'ask' | 'deny'; policyVersion: number; expiresAt: number; readOnly: boolean }
export async function authorizeBrowserAction(_input: { actor: Actor; botId: string; subagentId: string; epoch: number; loaderId: string; origin: string; mutation: BrowserMutation }): Promise<BrowserAuthority> {
  throw new ComputerError(503, 'Browser action authority unavailable')
}

/** The existing ledger cannot establish that a host decision remains valid.
 * Until the shared authority supplies its replay/lease check, never execute. */
export async function verifyBrowserApproval(_input: { actor: Actor; botId: string; subagentId: string; epoch: number; actionId: string; policyVersion: number; expiresAt: number; loaderId: string; origin: string; mutation: BrowserMutation; digest: string }): Promise<void> {
  throw new ComputerError(503, 'Browser action authority unavailable')
}
