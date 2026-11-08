import 'server-only'
import { sql } from 'drizzle-orm'

/** A conservative prefilter in an already authorized Task read, not a grant.
 * Include any owner Run with a repository or retained binding; the full loader
 * still selects and authorizes the current source. Qualify the outer columns
 * explicitly because Drizzle strips their table names inside selected fields. */
export const taskReviewSourceHint = sql<boolean>`exists(select 1 from agent_runs r
  left join coding_workspace_bindings b on b."runId"=r.id and b."ownerId"=r."userId"
  where r."issueId"=issues.id and r."userId"=issues."userId"
    and (r."deviceRepoId" is not null or b."repoId" is not null))`
