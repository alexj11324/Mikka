import 'server-only'
import { deploymentSwitch } from '@/lib/deployment-switches'
import { othersMayUse } from './personal-policy'
import { z } from 'zod'
import { retainEnrollmentSourcesForAcceptance } from './subscription-enrollment-policy'
import { SubscriptionRefusal, type SubscriptionRoute } from '@mikka/protocol/subscription'
import { workspaceDb } from './workspace-db'
import { and, eq } from 'drizzle-orm'
import { workspaces, workspaceMembers } from './db/workspace-schema'
import { WorkspaceError } from './workspace-error'
import { pool } from './db'
import { captureDatabaseQuery } from './db/commit-effects'
import { byosEnabled, byosEnrollmentEnabled } from './cloud-computer-flag'
import { subscriptionRouteReady } from './subscription-routes'
import { SubscriptionRepository } from './subscription-repository'
import { SubscriptionService } from './subscription-service'
import { SubscriptionWorkerClient } from '../packages/daemon/src/subscription-worker-client'
import { infisicalWorkloadToken } from './infisical-workload'
import { AccessProjectionMissing, authorizedAccessName, subscriptionAccessSnapshot } from './subscription-access-snapshot'
import { join } from 'node:path'

export async function authorizeSubscriptionWorkspace(userId: string, workspaceId: string, borrowerId?: string) {
  z.uuid().parse(workspaceId)
  // This authorization contains one read and protects no later operation.
  // Its implicit transaction retains the same FOR SHARE lock until that read
  // ends; an existing workspace transaction still owns it through the proxy.
  const [row] = await workspaceDb.select({ id: workspaces.id }).from(workspaces)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaces.id, workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .for('share').limit(1)
  if (!row) throw new WorkspaceError('workspaceAccessDenied')
  if (borrowerId && borrowerId !== userId && !(await othersMayUse(pool, userId, workspaceId))) throw new SubscriptionRefusal('account_unavailable')
}
/** A subscription runs its owner's own bots in every workspace the owner belongs to (decision 2026-11-01-2240);
 * another member's bot only while the owner shares it there with 分享给团队成员 and the admin allows it. */
export async function authorizeSubscriptionUse(userId: string, workspaceId: string, consumerId?: string) {
  await authorizeSubscriptionWorkspace(userId, workspaceId)
  // Another member's bot needs 分享给团队成员 on, checked on every call: un-sharing or leaving stops it at once.
  if (consumerId && z.uuid().safeParse(consumerId).success) {
    const { rows: [bot] } = await pool.query<{ ownerId: string | null }>('SELECT "ownerId" FROM bots WHERE id=$1 AND "workspaceId"=$2', [consumerId, workspaceId])
    // A bot awaiting takeover (null owner) runs on nobody's subscription.
    if (bot && (bot.ownerId === null || (bot.ownerId !== userId && !(await othersMayUse(pool, userId, workspaceId))))) throw new SubscriptionRefusal('account_unavailable')
  }
}
export function subscriptionRuntime(nativeBroker = false, custodyOnly = false, options: { exportAccessLease?: boolean } = {}): SubscriptionService {
  if (!byosEnabled() && !(custodyOnly && byosEnrollmentEnabled())) throw new SubscriptionRefusal('backend_unavailable')
  const binary = process.env.MIKKA_BYOS_WORKER_BINARY ?? join(process.cwd(), 'packages/subscription-worker/bin/mikka-subscription-worker')
  // pool is request-scoped; never send a preview worker to the production DB.
  const databaseUrl = pool.options.connectionString
  // Capture the proxy's bound query while still in this request's DB scope;
  // later stream/tool callbacks must keep that same pool as the Go worker.
  const database = captureDatabaseQuery(pool)
  const infisicalOrigin = process.env.MIKKA_BYOS_INFISICAL_ORIGIN
  const project = process.env.MIKKA_BYOS_INFISICAL_PROJECT
  const environment = process.env.MIKKA_BYOS_INFISICAL_ENVIRONMENT
  const path = process.env.MIKKA_BYOS_INFISICAL_PATH
  const workloadToken = process.env.MIKKA_BYOS_INFISICAL_TOKEN
  const accessPath = process.env.MIKKA_BYOS_ACCESS_INFISICAL_PATH
  const accessProject = process.env.MIKKA_BYOS_ACCESS_INFISICAL_PROJECT
  const accessToken = process.env.MIKKA_BYOS_ACCESS_INFISICAL_TOKEN
  const custodyId = process.env.MIKKA_BYOS_CUSTODY_CLIENT_ID
  const custodySecret = process.env.MIKKA_BYOS_CUSTODY_CLIENT_SECRET
  const accessId = process.env.MIKKA_BYOS_ACCESS_CLIENT_ID
  const accessSecret = process.env.MIKKA_BYOS_ACCESS_CLIENT_SECRET
  const sharedCustodyIdentity = process.env.MIKKA_BYOS_SHARED_CUSTODY_IDENTITY === '1'
  if (sharedCustodyIdentity && (!custodyId || !custodySecret)) throw new SubscriptionRefusal('backend_unavailable')
  const staticIdentity = Boolean(workloadToken && (custodyOnly || (accessToken && accessToken !== workloadToken)))
  const workloadIdentity = Boolean(custodyId && custodySecret && (custodyOnly || (accessId && accessSecret && accessId !== custodyId)))
  if (!databaseUrl || !infisicalOrigin || !project || !environment || !path || !accessPath || accessPath === path || (!staticIdentity && !workloadIdentity && !(sharedCustodyIdentity && custodyId && custodySecret))) throw new SubscriptionRefusal('backend_unavailable')
  const resolveIdentity = staticIdentity ? undefined : async (executionOnly: boolean, signal?: AbortSignal) => executionOnly
    ? { accessToken: await infisicalWorkloadToken(infisicalOrigin, accessId!, accessSecret!, signal) }
    : { workloadToken: await infisicalWorkloadToken(infisicalOrigin, custodyId!, custodySecret!, signal) }
  // Built-in CPA inference transports are never registered. The separate plain
  // adapter uses CPA converters and Claude's required OAuth system prefix,
  // with Mikka's HTTP identity and no synthesized device metadata.
  return new SubscriptionService(new SubscriptionRepository(database), scope => {
    const snapshot = async (signal: AbortSignal | undefined, use: { bindingId: string; consumerId: string; runId?: string } | undefined, revision: unknown, allowMissingProjection = false) => {
      if (!use) throw new Error('subscription_access_unavailable')
      const name = await authorizedAccessName(database, scope, use, revision, authorizeSubscriptionWorkspace, allowMissingProjection)
      return subscriptionAccessSnapshot({ origin: infisicalOrigin, clientId: custodyId!, clientSecret: custodySecret!, project: accessProject ?? project, environment, path: accessPath, name, signal })
    }
    const resolve = sharedCustodyIdentity ? async (executionOnly: boolean, signal?: AbortSignal, use?: { bindingId: string; consumerId: string; runId?: string }, revision?: unknown) => {
      if (!executionOnly) return { workloadToken: await infisicalWorkloadToken(infisicalOrigin, custodyId!, custodySecret!, signal) }
      return { accessSnapshot: await snapshot(signal, use, revision) }
    } : resolveIdentity
    const streamIdentity = sharedCustodyIdentity ? async (signal?: AbortSignal, use?: { bindingId: string; consumerId: string; runId?: string }, revision?: unknown) => {
      try {
        return { accessSnapshot: await snapshot(signal, use, revision, true) }
      } catch (error) {
        if (error instanceof AccessProjectionMissing) return null
        throw error
      }
    } : undefined
    return new SubscriptionWorkerClient({ binary }, { scope, databaseUrl, infisicalOrigin, project, environment, path, workloadToken: sharedCustodyIdentity ? '' : workloadToken ?? '', accessPath, accessProject, accessToken: custodyOnly || sharedCustodyIdentity ? undefined : accessToken, retainEnrollmentSources: retainEnrollmentSourcesForAcceptance(), enrollmentAttemptPath: process.env.MIKKA_BYOS_ENROLLMENT_ATTEMPT_PATH, enrollmentClaimPath: process.env.MIKKA_BYOS_ENROLLMENT_CLAIM_PATH, enrollmentGrantPath: process.env.MIKKA_BYOS_ENROLLMENT_GRANT_PATH, enableRuntime: !custodyOnly, // Plain model calls run only after access() found the route ready for this owner (subscriptionRouteReady).
      enablePlainModels: !custodyOnly, enableCodexOAuth: deploymentSwitch('byosCodexOAuth'), enableClaudeOAuth: deploymentSwitch('byosClaudeOAuth'), ...(options.exportAccessLease && !custodyOnly ? { exportAccessLease: true } : {}) }, resolve, streamIdentity)
  }, {
    ready: async (route: SubscriptionRoute, ownerId: string) => !custodyOnly && await subscriptionRouteReady(route, ownerId),
    oauth: { codex: deploymentSwitch('byosCodexOAuth'), claude: deploymentSwitch('byosClaudeOAuth') },
    // Only a verified runner supplies native isolation; Vercel is not the runner.
    // The private device route also requires a server allow-list and the hosted
    // runner capability. This never enables raw nativeAuth credential export.
    nativeIsolation: nativeBroker ? 'verified_runtime' : 'none'
  }, undefined, authorizeSubscriptionUse, undefined, authorizeSubscriptionWorkspace)
}
