import 'server-only'
import type { Pool } from 'pg'
import type { SubscriptionService } from '@/lib/subscription-service'

type Service = Pick<SubscriptionService, 'repository' | 'worker' | 'status'>
export type SubscriptionCleanupFactory = () => Promise<Service>
const runtime: SubscriptionCleanupFactory = async () => (await import('@/lib/subscription-runtime')).subscriptionRuntime(false, true)

/** Uses the existing owner-bound worker, never its operator-wide cleanup batch. */
export async function cleanupAccountSubscriptions(ownerId: string, database: Pool, serviceFactory = runtime): Promise<string[]> {
  const connections = (await database.query<{ id: string }>(`SELECT c.id FROM byos_connections c WHERE c."ownerId"=$1 AND (
    c."credentialVersion">0 OR c.state NOT IN ('pending','disconnected') OR c."secretName" IS NOT NULL OR c."accessSecretName" IS NOT NULL OR c."stagedSecretName" IS NOT NULL OR c."stagedAccessName" IS NOT NULL
    OR EXISTS(SELECT 1 FROM byos_secret_artifacts a WHERE a."connectionId"=c.id)
    OR EXISTS(SELECT 1 FROM byos_enrollment_sources a WHERE a."connectionId"=c.id)) ORDER BY c.id`, [ownerId])).rows
  if (!connections.length) return []
  let service: Service
  try { service = await serviceFactory() } catch { return ['subscription_custody_cleanup_required'] }
  const reasons = new Set<string>()
  for (const { id } of connections) {
    try {
      const row = await service.repository.connection(ownerId, id)
      if (row.ownerId !== ownerId) throw new Error('subscriptionOwnerMismatch')
      const worker = service.worker(service.repository.scope(row)), signal = AbortSignal.timeout(20_000)
      if (row.state !== 'disconnected') await worker.call('disconnect', { revision: Number(row.epoch) }, signal)
      await worker.call('cleanup', {}, signal)
      const status = await service.status(ownerId, id, signal)
      const outstanding = (await database.query(`SELECT 1 FROM byos_connections c WHERE c.id=$1 AND c."ownerId"=$2 AND (
        c.state<>'disconnected' OR c."secretName" IS NOT NULL OR c."accessSecretName" IS NOT NULL OR c."stagedSecretName" IS NOT NULL OR c."stagedAccessName" IS NOT NULL
        OR EXISTS(SELECT 1 FROM byos_secret_artifacts a WHERE a."connectionId"=c.id AND a."deletedAt" IS NULL)
        OR EXISTS(SELECT 1 FROM byos_enrollment_sources a WHERE a."connectionId"=c.id AND a."deletedAt" IS NULL))`, [id, ownerId])).rowCount
      if (outstanding || status.state !== 'disconnected' || !status.cleanup || status.cleanup.pending || status.cleanup.failed || status.cleanup.uncertainCreates) reasons.add('subscription_custody_cleanup_required')
      // The existing worker explicitly has no upstream grant-revocation adapter.
      // Even acknowledged vault deletion must not be advertised as upstream OAuth revocation.
      reasons.add('subscription_provider_revocation_unavailable')
      // Do not remove the mapping: it remains necessary to inspect/retry unresolved custody/revocation.
    } catch { reasons.add('subscription_cleanup_failed') }
  }
  return [...reasons]
}
