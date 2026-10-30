import { sql } from 'drizzle-orm'
import { githubRepository } from '../run-pull-request'

/** Only PR receipts issued for the canonical repository can create a watch. */
export function publicationPrNumber(remoteKey: string, url: string): number | null {
  let repository: ReturnType<typeof githubRepository>
  try { repository = githubRepository(remoteKey) } catch { return null }
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return null
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(parsed.pathname)
  if (!match || match[1].toLowerCase() !== repository.owner.toLowerCase() || match[2].toLowerCase() !== repository.repo.toLowerCase()) return null
  const number = Number(match[3])
  return Number.isSafeInteger(number) ? number : null
}

/** Called in the publication receipt transaction. Do not reset delivered state on replay. */
export async function registerCiPublication(tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }, row: { userId: string; issueId: string; remoteKey: string; runId: string; scopeVersion: number | null; url: string; state: string; ciOriginRunId?: string }) {
  const number = publicationPrNumber(row.remoteKey, row.url)
  if (!number || row.scopeVersion === null || !['open', 'draft'].includes(row.state)) return
  if (row.ciOriginRunId) {
    // A CI continuation may advance an existing watch, but cannot create one.
    await tx.execute(sql`UPDATE github_ci_observations SET "chainDepth"=CASE WHEN "originRunId"=${row.runId} THEN "chainDepth" ELSE "chainDepth"+1 END,
      "originRunId"=${row.runId}, "scopeVersion"=${row.scopeVersion}, "expiresAt"=greatest("expiresAt",now()+interval '48 hours'),
      "nextCheckAt"=least("nextCheckAt",now()), "updatedAt"=now()
      WHERE "userId"=${row.userId} AND "issueId"=${row.issueId} AND "remoteKey"=${row.remoteKey} AND "prNumber"=${number} AND "scopeVersion"=${row.scopeVersion} AND "originRunId" IN (${row.ciOriginRunId},${row.runId})`)
    return
  }
  await tx.execute(sql`INSERT INTO github_ci_observations ("userId","issueId","remoteKey","prNumber","originRunId","scopeVersion","expiresAt")
    VALUES (${row.userId},${row.issueId},${row.remoteKey},${number},${row.runId},${row.scopeVersion},now()+interval '48 hours')
    ON CONFLICT ("userId","issueId","remoteKey","prNumber") DO UPDATE SET
      "originRunId"=EXCLUDED."originRunId", "scopeVersion"=EXCLUDED."scopeVersion", "chainDepth"=CASE WHEN github_ci_observations."originRunId"=EXCLUDED."originRunId" THEN github_ci_observations."chainDepth" ELSE 0 END,
      "expiresAt"=greatest(github_ci_observations."expiresAt",EXCLUDED."expiresAt"), "updatedAt"=now()
    WHERE (SELECT (r."createdAt",r.id) FROM agent_runs r WHERE r.id=EXCLUDED."originRunId") >=
          (SELECT (r."createdAt",r.id) FROM agent_runs r WHERE r.id=github_ci_observations."originRunId")`)
}
