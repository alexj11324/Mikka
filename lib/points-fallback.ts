import 'server-only'
import type { Pool } from 'pg'
import { PaidResourceError } from './abuse/policy'

/** The refusals that mean the workspace has no points to spend, not an outage. */
const NO_POINTS = new Set(['verification_required', 'free_allowance_used', 'points_exhausted'])

/**
 * Whether Mikka 默认 would be refused for points in this workspace right now:
 * its own balance, then each member's shared one (withSharedCredits), read
 * without reserving anything. The refusal code, or null when it would run.
 */
export async function hostedPointsRefusal(workspaceId: string, check?: (payer: string) => Promise<unknown>): Promise<string | null> {
  const [{ withSharedCredits }, admission] = await Promise.all([import('./credit-shares'), check ? null : import('./abuse/runtime')])
  try {
    await withSharedCredits(workspaceId, check ?? admission!.canUseMikkaPaid)
    return null
  } catch (error) {
    if (error instanceof PaidResourceError && NO_POINTS.has(error.code)) return error.code
    throw error
  }
}

export type PointsFallback =
  | { kind: 'api_key'; keyId: string; model: string }
  | { kind: 'subscription'; bindingId: string; model: string }

/**
 * 点数不足时改用本人的模型 (decision 2026-11-02-1450): the first entry of
 * 优先使用的模型 that a bot chat can run on now, in the person's order. Only
 * credentials usable in this workspace count (usableApiKeys and botModels
 * already apply the team's sharing switch and an admin's ban on sharing);
 * a key must reach chat and list the model, a subscription must be bound
 * here with quota left. Null when none can.
 */
export async function pointsFallback(pool: Pool, scope: { ownerId: string; workspaceId: string }): Promise<PointsFallback | null> {
  const [{ orderCandidates, readOrder, credentialStates }, { usableApiKeys }, { apiKeyChatBaseUrl }, { ExecutionSettings }] = await Promise.all([
    import('./model-order'), import('./model-api-keys'), import('./model-api-key-providers'), import('./execution-settings'),
  ])
  const candidates = await orderCandidates(pool, scope)
  const { entries } = await readOrder(pool, scope, candidates)
  if (!entries.length) return null
  const states = await credentialStates(pool, scope, entries, candidates)
  const keys = new Map((await usableApiKeys(pool, scope.ownerId, scope.workspaceId)).map(key => [key.id, key]))
  const bindings = await new ExecutionSettings(pool).chatModels(scope)
  for (const entry of entries) {
    const credential = states.get(entry.id)?.credential
    if (credential && !credential.usable && credential.reason === 'checking') return null
    if (!credential?.usable) continue
    if (entry.source.kind === 'api_key') {
      const key = keys.get(entry.source.keyId)
      if (key && apiKeyChatBaseUrl(key) && key.models.includes(entry.model)) return { kind: 'api_key', keyId: key.id, model: entry.model }
    } else {
      const { connectionId } = entry.source
      const binding = bindings.find(row => String(row.connectionId) === connectionId && row.modelId === entry.model)
      if (binding) return { kind: 'subscription', bindingId: binding.bindingId, model: entry.model }
    }
  }
  return null
}

/**
 * The points Mikka 默认 can spend in this workspace now, as the model menu
 * shows them: its own balance and each balance a member shared with it
 * (sharedCreditWorkspaces), counting only those that would admit a call,
 * and the free messages left before a card is needed (`trialLeft`). Never
 * another workspace's points the person merely has.
 */
export async function hostedPointsHere(workspaceId: string): Promise<{ points: number; trialLeft: number }> {
  const [{ sharedCreditWorkspaces }, { canUseMikkaPaid }, { balancePoints }] = await Promise.all([
    import('./credit-shares'), import('./abuse/runtime'), import('./billing/hosted-usage'),
  ])
  let points = 0
  let trialLeft = 0
  const account = await (await import('./billing/organization-account')).resolvePlatformBillingAccount(workspaceId)
  const payers = [account.accountWorkspaceId, ...account.organizationId ? [] : await sharedCreditWorkspaces(workspaceId)]
  for (const [index, payer] of payers.entries()) {
    try {
      const balance = await canUseMikkaPaid(payer)
      points += balancePoints(balance)
      // The workspace's own free messages (no card yet, TRIAL_MESSAGES); a sharer's never count here.
      if (index === 0 && 'trialLeft' in balance) trialLeft = balance.trialLeft
    } catch (error) {
      if (!(error instanceof PaidResourceError) || !NO_POINTS.has(error.code)) throw error
    }
  }
  return { points, trialLeft }
}
