import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { SubscriptionRepository } from '@/lib/subscription-repository'
import type { WorkspaceBotModel } from '@/lib/db/schema'

type Query = Pick<Pool | PoolClient, 'query'>

const ROUTES = { codex: 'codex_cpa', claude: 'claude_cpa' } as const
const MODEL_ID = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * The provider model a bot's subscription binding asks for. Deployment-configurable;
 * the defaults are each provider's coding model.
 */
export function botSubscriptionModelId(provider: 'codex' | 'claude', env: Record<string, string | undefined> = process.env): string {
  const configured = provider === 'codex' ? env.MIKKA_BYOS_CODEX_MODEL : env.MIKKA_BYOS_CLAUDE_MODEL
  if (configured && MODEL_ID.test(configured)) return configured
  return provider === 'codex' ? 'gpt-5-codex' : 'claude-sonnet-4-5'
}

/**
 * Connecting an account once is enough (docs/design/bot-settings.md): when a bot is
 * set to Codex / Claude and its owner has a connected account for that provider in
 * the bot's workspace, the bot gets a binding to it through the same
 * SubscriptionRepository.bind every binding uses (owner, workspace, connected
 * state, revision and provider are checked there). A live binding for the current
 * connection revision is reused. Returns the binding id, or null when there is no
 * connected account (the bot then shows 「未连接 … 订阅」).
 * Pass the transaction's client to make the binding part of the caller's write.
 */
export async function ensureBotSubscriptionBinding(query: Query, input: { ownerId: string; workspaceId: string; botId: string; model: WorkspaceBotModel | null }): Promise<string | null> {
  if (input.model !== 'codex' && input.model !== 'claude') return null
  const provider = input.model
  const { rows: [connection] } = await query.query<{ id: string; epoch: string }>(
    `select id, epoch from byos_connections where "ownerId" = $1 and "workspaceId" = $2 and provider = $3 and state = 'connected' and "removedAt" is null order by "createdAt" desc, id desc limit 1`,
    [input.ownerId, input.workspaceId, provider])
  if (!connection) return null
  const route = ROUTES[provider]
  const { rows: [live] } = await query.query<{ id: string }>(
    `select id from byos_bindings where "ownerId" = $1 and "workspaceId" = $2 and "consumerId" = $3 and "connectionId" = $4 and "connectionRevision" = $5 and route = $6 order by "createdAt" desc, id desc limit 1`,
    [input.ownerId, input.workspaceId, input.botId, connection.id, connection.epoch, route])
  if (live) return live.id
  return new SubscriptionRepository(query).bind(input.ownerId, input.workspaceId, input.botId, connection.id, Number(connection.epoch), route, botSubscriptionModelId(provider))
}
