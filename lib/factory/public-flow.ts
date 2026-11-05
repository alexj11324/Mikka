import type { PoolClient } from 'pg';
import type { ReviewVerdict } from '@mikka/protocol/run';
import type { FactoryTask } from './store';

export const FACTORY_PUBLIC_STAGES = ['triage','spec','implement','review','handoff','completed','cancelled'] as const;
export type FactoryPublicStage = typeof FACTORY_PUBLIC_STAGES[number];
export type FactoryNeedsYou = { kind: 'spec_review' | 'question' | 'pr_review' | 'blocked' | 'failed'; since: string };
export interface FactoryFlowView {
  version: 2; id: string; issueId: string; botId: string | null; revision: number;
  stage: FactoryPublicStage; stages: FactoryPublicStage[]; needsYou?: FactoryNeedsYou;
  review: { verdict: ReviewVerdict | null; candidateId: string | null; currentCandidateReviewed: boolean } | null;
  acceptance: { artifactId: string; version: number; runId: string; candidateId: string; counts: Record<string, number>; media: FactoryAcceptanceMedia[] } | null;
  pullRequest: { url: string; state: string } | null;
}
export interface FactoryAcceptanceMedia { captureId: string; kind: 'image' | 'video'; url: string; title: string; criterion: string | null; runId: string }
export function publicFactoryStage(stage: FactoryTask['stage'], status: FactoryTask['status'], merged: boolean): FactoryPublicStage {
  if (status === 'cancelled' || status === 'revoked') return 'cancelled';
  if (merged) return 'completed';
  return stage === 'clarify' ? 'triage' : stage === 'execute' || stage === 'verify' ? 'implement' :
    stage === 'approval' || stage === 'publish' || stage === 'monitor' ? 'handoff' : stage;
}
const iso = (value: Date | string) => new Date(value).toISOString();

/** Caller has performed the canonical owner/Bot/source/issue check. No report, transcript or run prompt is read. */
export async function readFactoryFlow(tx: Pick<PoolClient, 'query'>, task: FactoryTask): Promise<FactoryFlowView> {
  const { rows: [row] } = await tx.query(`SELECT current."createdAt",current."finishedAt",
    q."updatedAt" AS "questionSince", report."artifactId",report."candidateId" AS "reportCandidateId",report."runId" AS "reportRunId",report.counts,report.media,a."latestVersion",
    review."candidateId" AS "reviewCandidateId",review.output->'completion'->>'reviewVerdict' AS verdict,
    CASE WHEN publication."pullRequest" IS NULL THEN NULL ELSE jsonb_build_object('url',left(publication."pullRequest"->>'url',2000),'state',publication."pullRequest"->>'state') END AS "pullRequest",
    EXISTS(SELECT 1 FROM factory_merges m WHERE m."taskId"=$1 AND m."candidateId"=$3 AND m.status='merged') AS merged
    FROM factory_attempts current
    LEFT JOIN LATERAL (SELECT "updatedAt" FROM factory_questions WHERE "taskId"=$1 AND "userId"=$2 AND status='waiting_user' ORDER BY "updatedAt",id LIMIT 1) q ON true
    LEFT JOIN factory_acceptance_artifacts report ON report."taskId"=$1 AND report."candidateId"=$3
    LEFT JOIN artifacts a ON a.id=report."artifactId" AND a."userId"=$2
    LEFT JOIN LATERAL (SELECT "candidateId",output FROM factory_attempts WHERE "taskId"=$1 AND stage='review' AND "runId" IS NOT NULL AND status IN ('passed','failed','blocked','waiting') ORDER BY position DESC LIMIT 1) review ON true
    LEFT JOIN factory_candidates candidate ON candidate.id=$3 AND candidate."taskId"=$1
    LEFT JOIN run_publications publication ON publication."runId"=candidate."runId" AND publication."userId"=$2
    WHERE current.id=$4 AND current."taskId"=$1 LIMIT 1`, [task.id,task.userId,task.candidateId,task.attemptId]);
  const stage = publicFactoryStage(task.stage, task.status, row?.merged === true);
  const { rows: history } = await tx.query<{ stage: FactoryTask['stage'] }>(`SELECT stage,min(position) AS position FROM factory_attempts WHERE "taskId"=$1 GROUP BY stage ORDER BY min(position) LIMIT 8`,[task.id]);
  const stages = [...new Set(history.map(a => publicFactoryStage(a.stage, 'pending', false)))];
  if (!stages.includes(stage)) stages.push(stage);
  let needsYou: FactoryNeedsYou | undefined;
  const since = iso(row?.finishedAt ?? row?.createdAt ?? new Date());
  if (stage !== 'cancelled' && stage !== 'completed') {
    if (row?.questionSince) needsYou = { kind: 'question', since: iso(row.questionSince) };
    else if (task.status === 'failed') needsYou = { kind: 'failed', since };
    else if (task.status === 'blocked') needsYou = { kind: 'blocked', since };
    else if (task.stage === 'spec' && task.status === 'passed') needsYou = { kind: 'spec_review', since };
    else if (stage === 'handoff') needsYou = { kind: 'pr_review', since: iso(row?.createdAt ?? new Date()) };
  }
  const verdict = ['passed','changes_requested','needs_judgment'].includes(row?.verdict) ? row.verdict as ReviewVerdict : null;
  return { version: 2, id: task.id, issueId: task.issueId, botId: task.botId, revision: task.revision, stage, stages,
    ...(needsYou ? { needsYou } : {}),
    review: row?.reviewCandidateId ? { verdict, candidateId: row.reviewCandidateId, currentCandidateReviewed: row.reviewCandidateId === task.candidateId } : null,
    acceptance: row?.artifactId && row.latestVersion ? { artifactId: row.artifactId, version: row.latestVersion, runId: row.reportRunId,
      candidateId: row.reportCandidateId, counts: row.counts, media: row.media } : null,
    pullRequest: row?.pullRequest ?? null };
}
