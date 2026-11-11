import { sql } from 'drizzle-orm'
import { agentRuns, agents } from '@/lib/db/schema'

/** A bot's name as the app shows it: the person's Coordinator is always "Coordinator", whatever its row is called. */
const shownName = sql.raw(`case when exists (select 1 from coordinator_bots cb where cb."botId"=b.id) then 'Coordinator' else b.name end`)

/** A standalone execution identity uses its owning Bot. The Agent's own name is
 * the last resort: no current identity format lets it be inferred. The removed
 * `<harness> <uuid>` guess matched lib/device-agents.ts's device-Agent names, not
 * the Bot runtime's `Cloud <harness> <botId>`, so it named a device Agent
 * "Coordinator". ALE-77: showing the Agent's own name beats a wrong Bot. */
export const executionBotName = sql<string>`coalesce(
  (select ${shownName} from bot_cloud_runtimes bcr join bots b on b.id=bcr."botId" and b."ownerId"=bcr."ownerId"
    where bcr."agentId"=${agents.id} and bcr."ownerId"=${agents.userId} limit 1),
  ${agents.name}
)`

/** The dispatching Bot wins; hidden execution identities never become conversation names. */
export const runBotName = sql<string>`coalesce(
  (select ${shownName} from computer_run_bindings crb join bots b on b.id=crb."botId" and b."ownerId"=crb."ownerId" where crb."runId"=${agentRuns.id}),
  (select ${shownName} from bots b where b.id=${agentRuns.botId} and b."ownerId"=${agentRuns.userId}),
  ${executionBotName}
)`

/** The Bot a run belongs to, found the way `runBotName` finds its name (the Coordinator is one of them); null for a run no bot dispatched (an MCP client's). */
export const runBotId = sql<string | null>`coalesce(
  (select b.id from computer_run_bindings crb join bots b on b.id=crb."botId" and b."ownerId"=crb."ownerId" where crb."runId"=${agentRuns.id}),
  (select b.id from bots b where b.id=${agentRuns.botId} and b."ownerId"=${agentRuns.userId}),
  (select b.id from bot_cloud_runtimes bcr join bots b on b.id=bcr."botId" and b."ownerId"=bcr."ownerId"
    where bcr."agentId"=${agents.id} and bcr."ownerId"=${agents.userId} limit 1)
)`

/**
 * The Agent that executes a run, by product name (Claude Code, Codex, Cursor):
 * who did the work, as opposed to the Bot that dispatched it (R-78).
 */
export const runAgentName = sql<string>`case ${agents.harness} when 'claude_code' then 'Claude Code' when 'codex' then 'Codex' when 'cursor' then 'Cursor' else ${agents.harness} end`

/**
 * The start of a run's task (its prompt from `promptTaskStart`, so Factory guidance
 * prepended at dispatch never names the thread), enough for `threadName` (the first line, cut
 * at 60 characters): leading blank space dropped, then 400 characters. A list
 * names a thread from this instead of reading whole prompts.
 */
/** Only the recorded task range may name a thread; missing/invalid provenance never falls back to execution instructions. */
// These columns belong only to the current agent_runs row in every caller.
// Keep the repeated projection compact for citation wire budgets; int8 subtraction
// makes even invalid int32 extrema safe before CASE decides whether to slice.
export const runTaskPrompt = sql<string>`case when "promptTaskStart">=0 and "promptTaskLength" between 0 and length(prompt)-"promptTaskStart"::int8 then substr(prompt,"promptTaskStart"+1,"promptTaskLength") else '' end`
export const threadNamePrompt = sql<string>`left(ltrim(${runTaskPrompt}, E' \\t\\r\\n'), 400)`
/**
 * A run's prompt up to the end of its first line with a letter, in a query
 * that joins other tables (explicit `agent_runs`). `threadName` names a thread
 * by the first line `plainLine` leaves non-empty; it strips only markers and
 * emphasis, so a line with a letter is never empty and no later line is read.
 * The lines before it are kept, so the name equals the whole prompt's name.
 */
export const threadNameLines = sql<string | null>`substring(ltrim(${runTaskPrompt}, E' \\t\\r\\n') from E'^(?:[^[:alpha:]\\n]*\\n)*[^\\n]*')`
/** `threadNameLines` within `threadNamePrompt`'s 400 characters: the same name as `threadNamePrompt` gives. */
export const threadNameHead = sql<string | null>`left(${threadNameLines}, 400)`
