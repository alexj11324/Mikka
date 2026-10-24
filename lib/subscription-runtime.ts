import 'server-only'
import { SubscriptionRefusal, type SubscriptionRoute } from '@mikka/protocol/subscription'
import { workspaceDb } from './workspace-db'
import { requireWorkspace } from './workspace-access'
import { pool } from './db'
import { SubscriptionRepository } from './subscription-repository'
import { SubscriptionService } from './subscription-service'
import { SubscriptionWorkerClient } from '../packages/daemon/src/subscription-worker-client'

export async function authorizeSubscriptionWorkspace(userId: string, workspaceId: string) {
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, userId))
}
export function subscriptionRuntime(): SubscriptionService {
  if (process.env.MIKKA_BYOS_ENABLED !== '1') throw new SubscriptionRefusal('backend_unavailable')
  const binary = process.env.MIKKA_BYOS_WORKER_BINARY
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
  if (!binary || !databaseUrl || !infisicalOrigin || !project || !environment || !path || !workloadToken) throw new SubscriptionRefusal('backend_unavailable')
  // Built-in CPA inference transports are never registered. The separate plain
  // adapter uses CPA converters with Mikka's identity and no native metadata.
  const ready = new Set((process.env.MIKKA_BYOS_VALIDATED_NATIVE_ROUTES ?? '').split(',').filter(route => ['codex_cli', 'claude_code_cli'].includes(route)))
  const modelRoutes = new Set((process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES ?? '').split(',').filter(route => ['codex_cpa', 'claude_cpa'].includes(route)))
  return new SubscriptionService(new SubscriptionRepository(database), scope => new SubscriptionWorkerClient({ binary }, { scope, databaseUrl, infisicalOrigin, project, environment, path, workloadToken, enableRuntime: true, enablePlainModels: modelRoutes.has(scope.provider === 'codex' ? 'codex_cpa' : 'claude_cpa'), enableCodexOAuth: process.env.MIKKA_BYOS_CODEX_OAUTH === '1', enableClaudeOAuth: process.env.MIKKA_BYOS_CLAUDE_OAUTH === '1' }), {
    ready: (route: SubscriptionRoute) => ready.has(route) || modelRoutes.has(route),
    oauth: { codex: process.env.MIKKA_BYOS_CODEX_OAUTH === '1', claude: process.env.MIKKA_BYOS_CLAUDE_OAUTH === '1' },
    // Only a verified runner supplies native isolation; Vercel is not the runner.
    nativeIsolation: 'none'
  }, undefined, authorizeSubscriptionWorkspace)
}
