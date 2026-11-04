import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { gatewayAuth } from '@/lib/ai-gateway-auth'
import { executionMembersActive } from '@/lib/execution-identity'
import { apiKeyEndpoint } from '@/lib/model-api-key-providers'
import { openApiKeyForChat, usableApiKeys } from '@/lib/model-api-keys'
import { DECISION_MODEL, DECISIONS_URL } from './decision'
import type { DecisionTransport } from './decision-wire'

type Query = Pick<Pool | PoolClient, 'query'>
export interface DecisionScope { workspaceId: string; ownerId?: string; workspaceIds?: string[] }
interface ApiEntry { id: string; harness: string; model: string; keyId: string }
export interface DecisionRoute {
  modelId: string
  transport: DecisionTransport
  /** Rechecks the frozen selection and current authorization just before send. */
  authorize(): Promise<{ url: string; token: string }>
}

/** An untouched preference list is generated for the UI, not an explicit API
 * authorization. Do not skip an unavailable selected entry or pick a fallback. */
async function explicitApiEntry(query: Query, scope: DecisionScope): Promise<ApiEntry | null> {
  if (!scope.ownerId) return null
  const { rows: [entry] } = await query.query<ApiEntry>(
    'SELECT e.id,e.harness,e.model,e."sourceId" AS "keyId" FROM model_order_settings s ' +
    'JOIN model_order_entries e ON e."ownerId"=s."ownerId" AND e."workspaceId"=s."workspaceId" ' +
    'WHERE s."ownerId"=$1 AND s."workspaceId"=$2 AND s.customized=true AND e."sourceKind"=\'api_key\' ' +
    'ORDER BY e.position,e.id LIMIT 1', [scope.ownerId, scope.workspaceId])
  return entry ?? null
}
const sameEntry = (a: ApiEntry | null, b: ApiEntry) => !!a && a.id === b.id && a.keyId === b.keyId && a.model === b.model && a.harness === b.harness

async function apiIdentity(query: Query, scope: DecisionScope, entry: ApiEntry) {
  if (!scope.ownerId || !sameEntry(await explicitApiEntry(query, scope), entry)) throw Error('decisionSelectionChanged')
  const key = (await usableApiKeys(query, scope.ownerId, scope.workspaceId)).find(key => key.id === entry.keyId)
  if (!key || key.modelsError === 'invalid' || !key.models.includes(entry.model) ||
    !await executionMembersActive(scope.workspaceId, [scope.ownerId, key.ownerId])) throw Error('decisionApiKeyUnavailable')
  const endpoint = apiKeyEndpoint(key, 'codex')
  if (!endpoint || endpoint.protocol !== 'openai') throw Error('decisionTransportUnavailable')
  return { ownerId: key.ownerId, baseUrl: endpoint.baseUrl.replace(/\/+$/, '') }
}

/** Decision is a host API consumer, not a native subscription run. Explicit API
 * preference wins; subscription ordering and frozen task credentials are not
 * modified. The project default remains the existing Coordinator Flash model. */
export async function selectDecisionRoute(scope: DecisionScope, query?: Query): Promise<DecisionRoute | null> {
  query ??= (await import('@/lib/db')).pool
  const entry = await explicitApiEntry(query, scope)
  if (entry) {
    const selected = await apiIdentity(query, scope, entry)
    return {
      modelId: entry.model, transport: 'api-responses',
      async authorize() {
        const current = await apiIdentity(query, scope, entry)
        if (current.ownerId !== selected.ownerId || current.baseUrl !== selected.baseUrl) throw Error('decisionSelectionChanged')
        const credential = await openApiKeyForChat(query, scope.ownerId!, scope.workspaceId, entry.keyId)
        if (credential.keyOwnerId !== selected.ownerId || credential.baseUrl.replace(/\/+$/, '') !== selected.baseUrl) throw Error('decisionSelectionChanged')
        // The resolver also rechecks sharing while opening the secret. Repeat
        // catalogue/preference/membership validation after that asynchronous IO.
        const final = await apiIdentity(query, scope, entry)
        if (final.ownerId !== selected.ownerId || final.baseUrl !== selected.baseUrl) throw Error('decisionSelectionChanged')
        return { url: selected.baseUrl + '/responses', token: credential.apiKey }
      },
    }
  }
  const auth = await gatewayAuth()
  if (!auth) return null
  return {
    modelId: DECISION_MODEL, transport: 'gateway-chat-completions',
    async authorize() {
      // A new explicit API preference must not be bypassed after selection.
      if (await explicitApiEntry(query, scope)) throw Error('decisionSelectionChanged')
      return { url: DECISIONS_URL, token: auth.token }
    },
  }
}
