import 'server-only'
import { ComputerError } from '@/lib/computer/store'
import type { Actor } from './subagents'
import type { BrowserMutation } from './action-reviews'

/** Consumer boundary for the trusted host policy. The authoritative host
 * assignment and its atomic grant consumption have not been delivered here.
 * Do not substitute a model flag or workspace access for this decision.
 * For ask, expose the same broker request through the existing pending_actions
 * UI and forward its one decision to the broker; never mint a second approval. */
export type BrowserAuthority = { decision: 'allow' | 'ask' | 'deny'; policyVersion: number; expiresAt: number; readOnly: boolean; review?: { actionId: string; digest: string; summary: string } }
export async function authorizeBrowserAction(_input: { permissionAction: 'computer_use'; actor: Actor; botId: string; subagentId: string; epoch: number; loaderId: string; origin: string; mutation: BrowserMutation; summary: string }): Promise<BrowserAuthority> {
  throw new ComputerError(503, 'Browser action authority unavailable')
}

/** The host must atomically revalidate and consume the exact grant at I/O;
 * an earlier policy decision alone does not authorize a later direct call. */
export async function executeAuthorizedBrowserAction(_input: { actor: Actor; botId: string; subagentId: string; epoch: number; policyVersion: number; expiresAt: number; loaderId: string; origin: string; mutation: BrowserMutation }): Promise<Record<string, unknown>> {
  throw new ComputerError(503, 'Browser action authority unavailable')
}

/** Navigation can itself cause external effects. Do not bypass the shared
 * authority while its navigation decision and one-use grant are unavailable. */
export async function executeAuthorizedBrowserNavigation(_input: { permissionAction: 'computer_use'; actor: Actor; botId: string; subagentId: string; epoch: number; url: string }): Promise<void> {
  throw new ComputerError(503, 'Browser navigation authority unavailable')
}

/** The existing ledger cannot establish that a host decision remains valid.
 * Until the shared authority supplies its replay/lease check, never execute. */
export async function executeReviewedBrowserAction(_input: { actor: Actor; botId: string; subagentId: string; epoch: number; actionId: string; policyVersion: number; expiresAt: number; loaderId: string; origin: string; mutation: BrowserMutation; digest: string }): Promise<Record<string, unknown>> {
  throw new ComputerError(503, 'Browser action authority unavailable')
}
