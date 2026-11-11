import 'server-only'
import { db, pool } from '@/lib/db'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import type { CoordinatorEventInput } from '@/lib/coordinator-events'
import { linkedCiSuiteRun, type CompletedCiSuite, type LinkedCiSuiteRun } from './ci-suite-event'

/**
 * A completed suite wakes only the newest published, already-ended Agent run
 * bound to a PR. An associated PR head SHA is checked when GitHub provides
 * one; the suite SHA may instead be a synthetic merge commit.
 * No new dispatcher or polling loop.
 * The existing Coordinator outbox is durable, deduplicated and wakes Eve after
 * commit. It requests a fresh GitHub read; it does not grant merge authority.
 */
export async function wakeLinkedCiSuite(
  suite: CompletedCiSuite,
  dependencies: {
    query: (statement: string, params: unknown[]) => Promise<{ rows: LinkedCiSuiteRun[] }>
    send: (event: CoordinatorEventInput) => Promise<unknown>
  } = {
    query: (statement, params) => pool.query<LinkedCiSuiteRun>(statement, params),
    send: (event) => recordCoordinatorEvent(db, event),
  },
): Promise<number> {
  const repoPrefix = `https://github.com/${suite.repository}/pull/`
  const links = suite.numbers.map(number => repoPrefix + number)
  const { rows } = await dependencies.query(
    `SELECT DISTINCT ON (p."userId", r."botId", p."pullRequest"->>'url')
      p."runId" AS "runId",r."userId" AS "userId",r."botId" AS "botId",
      r."issueId" AS "issueId",p."pullRequest"->>'url' AS "pullUrl",
      p."pullRequest"->>'headSha' AS "headSha",p."pullRequest"->>'state' AS state
      FROM run_publications p JOIN agent_runs r
        ON r.id=p."runId" AND r."userId"=p."userId" AND r."issueId" IS NOT DISTINCT FROM p."issueId"
      WHERE p.status='published' AND r."botId" IS NOT NULL AND r."finishedAt" IS NOT NULL
        AND r."stopRequestedAt" IS NULL
        AND lower(p."remoteKey")=ANY($1::text[])
        AND p."pullRequest"->>'state' IN ('open','draft')
        AND starts_with(lower(p."pullRequest"->>'url'),$3)
        AND ((cardinality($4::text[])=0 AND p."pullRequest"->>'headSha'=$2)
          OR (cardinality($4::text[])>0 AND lower(p."pullRequest"->>'url')=ANY($4::text[])))
      ORDER BY p."userId",r."botId",p."pullRequest"->>'url',p."updatedAt" DESC
      LIMIT 50`,
    [[suite.repository, `v2/github.com/${suite.repository}`], suite.headSha, repoPrefix, links],
  )
  let sent = 0
  for (const row of rows) {
    if (!linkedCiSuiteRun(suite, row)) continue
    await dependencies.send({
      userId: row.userId,
      botId: row.botId,
      issueId: row.issueId,
      runId: row.runId,
      kind: 'run_report',
      dedupeKey: `github_ci_suite:${row.runId}:${suite.repository}:${suite.headSha}:${suite.suiteId}:${suite.conclusion}`,
      // Host-generated text; never copy webhook prose into the model's instructions.
      payload: {
        source: 'github_ci_suite',
        text: 'Linked PR CI suite completed. Read the current GitHub PR head, every required check and branch rules before deciding on repair or merge. This signal is not authorization.',
        repository: suite.repository,
        pullUrl: row.pullUrl,
        suiteHeadSha: suite.headSha,
        suiteId: suite.suiteId,
        conclusionHint: suite.conclusion,
      },
    })
    sent++
  }
  return sent
}
