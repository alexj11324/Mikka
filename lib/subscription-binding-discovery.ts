import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import type { Pool } from 'pg'
import { SubscriptionRepository } from './subscription-repository'

/** Persisted subscription intent survives runtime disablement. Discovery must
 * never depend on service credentials/enablement, or it could select paid/local
 * fallback during an emergency shutdown. Pre-migration installations stay valid. */
export async function subscriptionRepositoryIfInstalled(database: Pick<Pool,'query'>) {
  const { rows } = await database.query("SELECT to_regclass('byos_bindings') IS NOT NULL AS installed")
  return rows[0]?.installed === true ? new SubscriptionRepository(database) : null
}

export async function nativeSubscriptionForClaim(database: Pick<Pool,'query'>, ownerId: string, consumerId: string, harness: string, enabled: boolean) {
  const binding = await (await subscriptionRepositoryIfInstalled(database))?.nativeBinding(ownerId, consumerId, harness)
  if (binding && !enabled) throw new SubscriptionRefusal('backend_unavailable')
  return binding
}
