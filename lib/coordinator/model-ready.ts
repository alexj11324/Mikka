import 'server-only'
import { pool } from '@/lib/db'
import { ExecutionSettings, executionWorkspace } from '@/lib/execution-settings'
import { botModelPreference, resolveBotModelChoice } from '@/lib/bot-model-choice'
import { subscriptionAvailability } from '@/lib/subscription-quota'
import { ActionFailureError } from '@/lib/action-error'
import { WorkspaceError } from '@/lib/workspace-error'
import { isCloudEdition } from '@/lib/edition'

/** A chat may use its own selected credential without any server default.
 * Scope, connection revision, pause state, route and shared-credential access
 * use the same readers as reservation. This never writes a binding or calls a
 * provider; execution still refreshes and authorizes the credential itself. */
export async function botModelReady(ownerId: string, botId: string | null): Promise<boolean> {
  let workspaceId: string
  try { workspaceId = await executionWorkspace(ownerId, botId) }
  catch (error) {
    // One archived or suspended chat must not prevent the owner's other chats
    // from waking. Database failures still propagate and remain observable.
    if (error instanceof ActionFailureError && error.code === 'botNotFound'
      || (error instanceof WorkspaceError || error instanceof ActionFailureError) && error.code === 'workspaceAccessDenied') return false
    throw error
  }
  const scope = { ownerId, workspaceId }
  const settings = new ExecutionSettings(pool)
  const choice = await resolveBotModelChoice(pool, settings, scope, botId, await botModelPreference(pool, scope, botId))
  if (choice.kind === 'apiKey') return true
  // Mikka 额度 wakes like any other source (decision 2026-11-16-0100): a task
  // report or schedule starts a turn when the chosen model is offered here and
  // the balance can pay for it. An empty balance is the known exhausted case.
  if (choice.kind === 'hosted') return creditsReady(choice.model, ownerId, workspaceId)
  if (choice.kind !== 'subscription') return false
  const { binding } = choice
  // A stale allowance may queue the next authoritative check, just as the
  // model picker does. A known exhausted choice needs its configured fallback.
  return subscriptionAvailability(binding.quota, binding.modelId, binding.provider === 'codex' ? 'codex' : 'claude').status !== 'exhausted'
}

async function creditsReady(model: string, ownerId: string, workspaceId: string): Promise<boolean> {
  if (!await (await import('@/lib/credits-models')).creditsModelOffered(model, ownerId)) return false
  // A self-hosted server meters its own provider; only Mikka Cloud holds a balance.
  if (!isCloudEdition()) return true
  return await (await import('@/lib/points-fallback')).hostedPointsRefusal(workspaceId) === null
}
