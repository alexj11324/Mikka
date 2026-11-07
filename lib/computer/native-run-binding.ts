import 'server-only'
import type { Pool } from 'pg'
import { SubscriptionRepository } from '@/lib/subscription-repository'
/** Scheduling reads only metadata. Actual native credentials still require the
 * existing subscriptionRuntime custody/authentication path at execution time. */
export async function nativeRunBinding(pool: Pick<Pool, 'query'>, userId: string, agentId: string, harness: string, workspaceId?: string, bindingId?: string) {
  if (harness !== 'codex' && harness !== 'claude_code') return null
  const repository = new SubscriptionRepository(pool)
  const binding = await repository.nativeBinding(userId, agentId, harness, bindingId, workspaceId, { currentConnection: true })
  if (!binding || binding.consumerId !== agentId || binding.route !== (harness === 'codex' ? 'codex_cli' : 'claude_code_cli') || (workspaceId && binding.workspaceId !== workspaceId)) return null
  return binding
}
