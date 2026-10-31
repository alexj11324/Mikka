import 'server-only'
import { subscriptionsUsable } from './personal-policy'
import { retainEnrollmentSourcesForAcceptance } from './subscription-enrollment-policy'
import { SubscriptionRefusal, type SubscriptionRoute } from '@mikka/protocol/subscription'
import { workspaceDb } from './workspace-db'
import { requireWorkspace } from './workspace-access'
import { pool } from './db'
import { SubscriptionRepository } from './subscription-repository'
import { SubscriptionService } from './subscription-service'
import { SubscriptionWorkerClient } from '../packages/daemon/src/subscription-worker-client'
import { infisicalWorkloadToken } from './infisical-workload'
import { authorizedAccessName, subscriptionAccessSnapshot } from './subscription-access-snapshot'
import { join } from 'node:path'

export async function authorizeSubscriptionWorkspace(userId: string, workspaceId: string) {
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, userId))
}
/** A subscription runs in a workspace only for a member who shared it there, and only while that
 * workspace's admin allows it; otherwise a frozen run stops, never falls back (decision 2026-10-31-2225). */
export async function authorizeSubscriptionUse(userId: string, workspaceId: string) {
  await authorizeSubscriptionWorkspace(userId, workspaceId)
  if (!(await subscriptionsUsable(pool, userId, workspaceId))) throw new SubscriptionRefusal('account_unavailable')
}
export function subscriptionRuntime(nativeBroker = false, custodyOnly = false): SubscriptionService {
  if (process.env.MIKKA_BYOS_ENABLED !== '1' && !(custodyOnly && process.env.MIKKA_BYOS_ENROLLMENT_ENABLED === '1')) throw new SubscriptionRefusal('backend_unavailable')
  const binary = process.env.MIKKA_BYOS_WORKER_BINARY ?? join(process.cwd(), 'packages/subscription-worker/bin/mikka-subscription-worker')
  // pool is request-scoped; never send a preview worker to the production DB.
  const databaseUrl = pool.options.connectionString
  // Capture the proxy's bound query while still in this request's DB scope;
  // later stream/tool callbacks must keep that same pool as the Go worker.
  const database = { query: pool.query }
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
  // adapter uses CPA converters with Mikka's identity and no native metadata.
  const ready = new Set((process.env.MIKKA_BYOS_VALIDATED_NATIVE_ROUTES ?? '').split(',').filter(route => ['codex_cli', 'claude_code_cli'].includes(route)))
  const modelRoutes = new Set((process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES ?? '').split(',').filter(route => ['codex_cpa', 'claude_cpa'].includes(route)))
  return new SubscriptionService(new SubscriptionRepository(database), scope => {
    const resolve = sharedCustodyIdentity ? async (executionOnly: boolean, signal?: AbortSignal, use?: { bindingId: string; consumerId: string; runId?: string }, revision?: unknown) => {
      if (!executionOnly) return { workloadToken: await infisicalWorkloadToken(infisicalOrigin, custodyId!, custodySecret!, signal) }
      if (!use) throw new Error('subscription_access_unavailable')
      const name = await authorizedAccessName(database, scope, use, revision)
      return { accessSnapshot: await subscriptionAccessSnapshot({ origin: infisicalOrigin, clientId: custodyId!, clientSecret: custodySecret!, project: accessProject ?? project, environment, path: accessPath, name, signal }) }
    } : resolveIdentity
    return new SubscriptionWorkerClient({ binary }, { scope, databaseUrl, infisicalOrigin, project, environment, path, workloadToken: sharedCustodyIdentity ? '' : workloadToken ?? '', accessPath, accessProject, accessToken: custodyOnly || sharedCustodyIdentity ? undefined : accessToken, retainEnrollmentSources: retainEnrollmentSourcesForAcceptance(), enrollmentAttemptPath: process.env.MIKKA_BYOS_ENROLLMENT_ATTEMPT_PATH, enrollmentClaimPath: process.env.MIKKA_BYOS_ENROLLMENT_CLAIM_PATH, enrollmentGrantPath: process.env.MIKKA_BYOS_ENROLLMENT_GRANT_PATH, enableRuntime: !custodyOnly, enablePlainModels: !custodyOnly && modelRoutes.has(scope.provider === 'codex' ? 'codex_cpa' : 'claude_cpa'), enableCodexOAuth: process.env.MIKKA_BYOS_CODEX_OAUTH === '1', enableClaudeOAuth: process.env.MIKKA_BYOS_CLAUDE_OAUTH === '1' }, resolve)
  }, {
    ready: (route: SubscriptionRoute) => !custodyOnly && (ready.has(route) || modelRoutes.has(route)),
    oauth: { codex: process.env.MIKKA_BYOS_CODEX_OAUTH === '1', claude: process.env.MIKKA_BYOS_CLAUDE_OAUTH === '1' },
    // Only a verified runner supplies native isolation; Vercel is not the runner.
    // The private device route also requires a server allow-list and the hosted
    // runner capability. This never enables raw nativeAuth credential export.
    nativeIsolation: nativeBroker ? 'verified_runtime' : 'none'
  }, undefined, authorizeSubscriptionUse)
}
