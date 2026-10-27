// Synthetic metadata only. No token or real account is needed by BYOS tests.
import { SUBSCRIPTION_ROUTES, type SubscriptionAccess, type SubscriptionRoute, type SubscriptionUse } from '@mikka/protocol/subscription'

export const SUBSCRIPTION_TEST_NOW = Date.parse('2026-10-24T06:00:00Z')
export function subscriptionFixture(route: SubscriptionRoute = 'codex_cli') {
  const spec = SUBSCRIPTION_ROUTES[route]
  const use: SubscriptionUse = {
    ownerId: 'alice', workspaceId: 'workspace-a', consumerId: 'bot-a',
    bindingId: '10000000-0000-4000-8000-000000000001', execution: spec.execution,
  }
  const access: SubscriptionAccess = {
    binding: {
      id: use.bindingId, ownerId: use.ownerId, workspaceId: use.workspaceId,
      consumerId: use.consumerId, connectionId: 'connection-a', connectionRevision: 1, route,
    },
    connection: {
      id: 'connection-a', ownerId: use.ownerId, workspaceId: use.workspaceId,
      provider: spec.provider, state: 'connected', revision: 1,
      quota: {
        vendor: spec.provider === 'openai' ? 'codex' : 'claude_code', source: 'official',
        status: 'ok', plan: null, observedAt: new Date(SUBSCRIPTION_TEST_NOW).toISOString(),
        windows: [{ kind: 'five_hour', used: 0.2, resetsAt: null }],
      },
    },
    backend: {
      connectionId: 'connection-a', connectionRevision: 1, ownerId: use.ownerId,
      workspaceId: use.workspaceId, route, readiness: 'ready', billing: 'subscription_only',
      isolation: spec.execution === 'native' ? 'verified_runtime' : 'credential_broker',
    },
  }
  return { use, access }
}
