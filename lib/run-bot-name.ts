import { sql } from 'drizzle-orm'
import { agentRuns, agents } from '@/lib/db/schema'

/** A standalone execution identity uses its owning Bot, or the Coordinator for local work. */
export const executionBotName = sql<string>`coalesce(
  (select b.name from bot_cloud_runtimes bcr join bots b on b.id=bcr."botId" and b."ownerId"=bcr."ownerId"
    where bcr."agentId"=${agents.id} and bcr."ownerId"=${agents.userId} limit 1),
  case when ${agents.name} ~ '^(claude_code|codex|mock) [0-9a-f-]{36}$' then 'Coordinator' else ${agents.name} end
)`

/** The dispatching Bot wins; hidden execution identities never become conversation names. */
export const runBotName = sql<string>`coalesce(
  (select b.name from computer_run_bindings crb join bots b on b.id=crb."botId" and b."ownerId"=crb."ownerId" where crb."runId"=${agentRuns.id}),
  (select b.name from bots b where b.id=${agentRuns.botId} and b."ownerId"=${agentRuns.userId}),
  ${executionBotName}
)`
