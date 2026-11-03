import 'server-only'
import type { Pool } from 'pg'
import { runCredentialSource } from '@/lib/run-credential-source'
import { ensureBotCloudRuntime } from './auto-runtime'
import { nativeRunBinding } from './native-run-binding'
import { computerPermission } from './permission'
import { ComputerError } from './store'

/** The caller has authorized the Bot, workspace, issue and optional suggestion.
 * Check this already-selected credential and the desktop policy before waking
 * anything. The queue rechecks admission after the provider returns. */
export async function prepareBotCloudTaskRuntime(pool: Pool, actor: { userId: string; workspaceId: string }, input: {
  botId: string; agentId: string; harness: 'codex' | 'claude_code'; model: string
  repo?: string; withoutBot?: boolean; subscriptionBindingId?: string; apiKeyId?: string
}) {
  if (!input.repo) {
    const policy = (await pool.query('SELECT permission FROM workspace_computer_policies WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0]
    if (computerPermission(policy?.permission) !== 'allow') throw new ComputerError(409, 'Bot computer task is unavailable')
  }
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!model || model === 'auto' || (input.subscriptionBindingId && input.apiKeyId)) throw new ComputerError(409, 'Bot subscription unavailable')
  const binding = await nativeRunBinding(pool, actor.userId, input.agentId, input.harness, actor.workspaceId, input.subscriptionBindingId)
  if (input.subscriptionBindingId && (!binding || binding.id !== input.subscriptionBindingId || binding.modelId !== model)) throw new ComputerError(409, 'Bot subscription unavailable')
  const botId = input.withoutBot ? null : input.botId
  const { subscription, apiKey } = await runCredentialSource(pool, {
    ownerId: actor.userId, botId, harness: input.harness, model, keyId: input.apiKeyId,
    botWorkspaceId: botId ? actor.workspaceId : null, choiceWorkspaceId: actor.workspaceId, subscription: binding,
  })
  if ((!subscription && !apiKey) || (subscription && subscription.modelId !== model) || (apiKey && apiKey.model !== model) ||
    (input.apiKeyId && apiKey?.keyId !== input.apiKeyId)) throw new ComputerError(409, 'Bot subscription unavailable')
  // Omitting model is intentional: runtime preparation must not auto-bind the
  // owner's newest subscription or replace the caller's explicit selection.
  return ensureBotCloudRuntime(pool, actor, input.botId, { harness: input.harness })
}
