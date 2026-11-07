import 'server-only'
import { pool } from '@/lib/db'
import { ExecutionSettings, executionWorkspace } from '@/lib/execution-settings'
import { botModelPreference, resolveBotModelChoice } from '@/lib/bot-model-choice'
import { subscriptionAvailability } from '@/lib/subscription-quota'
import { ActionFailureError } from '@/lib/action-error'
import { WorkspaceError } from '@/lib/workspace-error'

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
  if (choice.kind !== 'subscription') return false
  const { binding } = choice
  // A stale allowance may queue the next authoritative check, just as the
  // model picker does. A known exhausted choice needs its configured fallback.
  return subscriptionAvailability(binding.quota, binding.modelId, binding.provider === 'codex' ? 'codex' : 'claude').status !== 'exhausted'
}
