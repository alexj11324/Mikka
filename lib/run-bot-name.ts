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

/** Until the Coordinator's chat moves to its bot row, its threads stay the Coordinator's (null), also on its cloud runtime. */
const notCoordinator = sql`not exists (select 1 from coordinator_bots cb where cb."botId"=b.id)`

/** The Bot a run belongs to, found the way `runBotName` finds its name; null for the Coordinator's own work. */
export const runBotId = sql<string | null>`coalesce(
  (select b.id from computer_run_bindings crb join bots b on b.id=crb."botId" and b."ownerId"=crb."ownerId" where ${notCoordinator} and crb."runId"=${agentRuns.id}),
  (select b.id from bots b where b.id=${agentRuns.botId} and b."ownerId"=${agentRuns.userId} and ${notCoordinator}),
  (select b.id from bot_cloud_runtimes bcr join bots b on b.id=bcr."botId" and b."ownerId"=bcr."ownerId"
    where bcr."agentId"=${agents.id} and bcr."ownerId"=${agents.userId} and ${notCoordinator} limit 1)
)`

/**
 * The Agent that executes a run, by product name (Claude Code, Codex, Cursor):
 * who did the work, as opposed to the Bot that dispatched it (R-78).
 */
export const runAgentName = sql<string>`case ${agents.harness} when 'claude_code' then 'Claude Code' when 'codex' then 'Codex' when 'cursor' then 'Cursor' else ${agents.harness} end`
