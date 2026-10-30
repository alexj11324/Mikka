import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import type { AgentModelSource } from '@/lib/agent-model'
import { allowedModelsOf, bindingProvider, botModelRefusalText, chooseBotModelSource, type BotModelRefusalReason, type SubscriptionProvider } from '@/lib/workspace-admin/bot-model-policy'
import type { WorkspaceBotModel } from '@/lib/db/schema'

/** A refused bot turn. Its message is what the chat's failed-turn alert parses (parseBotModelRefusal). */
export class BotModelRefusal extends SubscriptionRefusal {
  constructor(readonly reason: BotModelRefusalReason, readonly family: WorkspaceBotModel | null) {
    super(reason)
    this.message = botModelRefusalText(reason, family)
  }
}

/** Codex / Claude bots need both the subscription backend and the agent kit (the run's frozen model selection). */
export function subscriptionModelsRunnable(): boolean {
  return process.env.MIKKA_BYOS_ENABLED === '1' && process.env.MIKKA_AGENT_KIT === '1'
}

/**
 * The model source a bot's run must use (docs/design/bot-settings.md): its owner's
 * choice while 可用模型 allows it, else the fallback. Returns undefined for Mikka's
 * hosted model, or the owner's subscription binding for this bot. Throws a
 * SubscriptionRefusal instead of switching provider when that binding is missing.
 */
export async function botRunModelSource(ownerId: string, botId: string, definitionSelection: AgentModelSource | undefined): Promise<AgentModelSource | undefined> {
  // Loaded on use: the workflow step module imports this file, and its tests stub the database module.
  const [{ db }, { bots, workspaceSettings }] = await Promise.all([import('@/lib/db'), import('@/lib/db/schema')])
  const [bot] = await db.select({ model: bots.model, workspaceId: bots.workspaceId }).from(bots).where(and(eq(bots.id, botId), eq(bots.ownerId, ownerId))).limit(1)
  if (!bot) throw new SubscriptionRefusal('binding_mismatch')
  const [policy] = await db.select({ allowedModels: workspaceSettings.allowedModels, startingModel: workspaceSettings.defaultModel })
    .from(workspaceSettings).where(eq(workspaceSettings.workspaceId, bot.workspaceId)).limit(1)
  // Newest hosted-route binding of this bot per provider whose connection is live at the bound revision.
  const { rows } = await db.execute<{ id: string; route: string }>(sql`
    select distinct on (case when b.route like 'claude%' then 'claude' else 'codex' end) b.id, b.route
    from byos_bindings b join byos_connections c on c.id = b."connectionId" and c."ownerId" = b."ownerId"
    where b."ownerId" = ${ownerId} and b."consumerId" = ${botId} and b."workspaceId" = ${bot.workspaceId}
      and c.state = 'connected' and c.epoch = b."connectionRevision"
      and b.route in ('codex_cpa', 'claude_cpa', 'openai_siwc')
    order by case when b.route like 'claude%' then 'claude' else 'codex' end, b."createdAt" desc, b.id desc`)
  const latestBindings: Partial<Record<SubscriptionProvider, string>> = {}
  for (const row of rows) latestBindings[bindingProvider(row.route)] = row.id
  let definitionBinding: { id: string; provider: SubscriptionProvider } | null = null
  if (definitionSelection) {
    const { rows: [bound] } = await db.execute<{ route: string }>(sql`select route from byos_bindings where id = ${definitionSelection.bindingId} and "ownerId" = ${ownerId}`)
    if (bound) definitionBinding = { id: definitionSelection.bindingId, provider: bindingProvider(bound.route) }
  }
  const allowedModels = allowedModelsOf(policy?.allowedModels)
  const choice = chooseBotModelSource({
    storedModel: bot.model, allowedModels, startingModel: policy?.startingModel ?? null,
    definitionBinding, latestBindings, subscriptionsRunnable: subscriptionModelsRunnable(),
  })
  if ('refused' in choice) throw new BotModelRefusal(choice.refused, choice.family)
  return choice.source
}
