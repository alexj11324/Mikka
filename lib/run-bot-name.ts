import { sql } from 'drizzle-orm'
import { agentRuns, agents } from '@/lib/db/schema'

/** Hidden local execution identities never become names in a conversation. */
export const runBotName = sql<string>`coalesce(
  (select b.name from computer_run_bindings crb join bots b on b.id=crb."botId" and b."ownerId"=crb."ownerId" where crb."runId"=${agentRuns.id}),
  (select b.name from bots b where b.id=${agentRuns.botId} and b."ownerId"=${agentRuns.userId}),
  case when ${agents.name} ~ '^(claude_code|codex|mock) [0-9a-f-]{36}$' then 'Coordinator' else ${agents.name} end
)`
