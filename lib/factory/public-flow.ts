import type { PoolClient } from 'pg';
import type { ReviewVerdict } from '@mikka/protocol/run';
import type { FactoryTask } from './store';

export const FACTORY_PUBLIC_STAGES = ['triage','spec','implement','review','handoff','completed','cancelled'] as const;
export type FactoryPublicStage = typeof FACTORY_PUBLIC_STAGES[number];
export type FactoryNeedsYou = { kind: 'spec_review' | 'question' | 'pr_review' | 'blocked' | 'failed'; since: string };
export interface FactoryFlowView {
  version: 2; id: string; issueId: string; botId: string | null; revision: number;
  stage: FactoryPublicStage; stages: FactoryPublicStage[]; needsYou?: FactoryNeedsYou;
  completion?: 'merged' | 'accepted';
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
type FlowStateEvidence = { merged?: boolean; accepted?: boolean; createdAt?: Date | string; finishedAt?: Date | string | null; questionSince?: Date | string | null };

/** Full detail and batched summaries use the same task state and attention rules. */
export function publicFactoryState(task: Pick<FactoryTask, 'stage' | 'status'>, evidence: FlowStateEvidence = {}): Pick<FactoryFlowView, 'stage' | 'needsYou' | 'completion'> {
  const stage = publicFactoryStage(task.stage, task.status, evidence.merged === true || evidence.accepted === true);
  let needsYou: FactoryNeedsYou | undefined;
  const since = iso(evidence.finishedAt ?? evidence.createdAt ?? new Date());
  if (stage !== 'cancelled' && stage !== 'completed') {
    if (evidence.questionSince) needsYou = { kind: 'question', since: iso(evidence.questionSince) };
    else if (task.status === 'failed') needsYou = { kind: 'failed', since };
    else if (task.status === 'blocked') needsYou = { kind: 'blocked', since };
    else if (task.stage === 'clarify' && task.status === 'waiting') needsYou = { kind: 'question', since };
    else if (task.stage === 'spec' && task.status === 'passed') needsYou = { kind: 'spec_review', since };
    else if (stage === 'handoff') needsYou = { kind: 'pr_review', since: iso(evidence.createdAt ?? new Date()) };
  }
  return { stage, ...(needsYou ? { needsYou } : {}), ...(stage === 'completed' ? { completion: evidence.accepted === true ? 'accepted' as const : 'merged' as const } : {}) };
}

/** One evidence read for an already-authorized issue list, never a detail read per task. */
export async function readFactoryFlowStates(tx: Pick<PoolClient, 'query'>, tasks: readonly FactoryTask[]) {
  if (!tasks.length) return new Map<string, Pick<FactoryFlowView, 'stage' | 'needsYou' | 'completion'>>();
  const { rows } = await tx.query<FlowStateEvidence & { id: string }>(`SELECT t.id,current."createdAt",current."finishedAt",q."updatedAt" AS "questionSince",
    EXISTS(SELECT 1 FROM factory_merges m WHERE m."taskId"=t.id AND m."candidateId"=t."candidateId" AND m."userId"=t."userId" AND m.status='merged' AND candidate.kind='repository') AS merged,
    EXISTS(SELECT 1 FROM factory_deliverable_acceptances a WHERE a."taskId"=t.id AND a."candidateId"=t."candidateId" AND a."userId"=t."userId" AND candidate.kind IN ('report','deliverable')) AS accepted
    FROM factory_tasks t LEFT JOIN factory_attempts current ON current.id=t."attemptId" AND current."taskId"=t.id
    LEFT JOIN factory_candidates candidate ON candidate.id=t."candidateId" AND candidate."taskId"=t.id
    LEFT JOIN LATERAL (SELECT "updatedAt" FROM factory_questions WHERE "taskId"=t.id AND "userId"=t."userId" AND status='waiting_user' ORDER BY "updatedAt",id LIMIT 1) q ON true
    WHERE t.id=ANY($1::uuid[])`, [tasks.map(task => task.id)]);
  const evidence = new Map(rows.map(row => [row.id, row]));
  return new Map(tasks.map(task => [task.id, publicFactoryState(task, evidence.get(task.id))]));
}

/** Caller has performed the canonical owner/Bot/source/issue check. No report, transcript or run prompt is read. */
export async function readFactoryFlow(tx: Pick<PoolClient, 'query'>, task: FactoryTask): Promise<FactoryFlowView> {
  const { rows: [row] } = await tx.query(`SELECT current."createdAt",current."finishedAt",
    q."updatedAt" AS "questionSince", report."artifactId",report."candidateId" AS "reportCandidateId",report."runId" AS "reportRunId",report.counts,report.media,a."latestVersion",
    review."candidateId" AS "reviewCandidateId",review.output->'completion'->>'reviewVerdict' AS verdict,
    CASE WHEN publication."pullRequest" IS NULL THEN NULL ELSE jsonb_build_object('url',left(publication."pullRequest"->>'url',2000),'state',publication."pullRequest"->>'state') END AS "pullRequest",
    EXISTS(SELECT 1 FROM factory_merges m WHERE m."taskId"=$1 AND m."candidateId"=$3 AND m."userId"=$2 AND m.status='merged' AND candidate.kind='repository') AS merged,
    EXISTS(SELECT 1 FROM factory_deliverable_acceptances accepted WHERE accepted."taskId"=$1 AND accepted."candidateId"=$3 AND accepted."userId"=$2 AND candidate.kind IN ('report','deliverable')) AS accepted
    FROM factory_attempts current
    LEFT JOIN LATERAL (SELECT "updatedAt" FROM factory_questions WHERE "taskId"=$1 AND "userId"=$2 AND status='waiting_user' ORDER BY "updatedAt",id LIMIT 1) q ON true
    LEFT JOIN factory_acceptance_artifacts report ON report."taskId"=$1 AND report."candidateId"=$3
    LEFT JOIN artifacts a ON a.id=report."artifactId" AND a."userId"=$2
    LEFT JOIN LATERAL (SELECT "candidateId",output FROM factory_attempts WHERE "taskId"=$1 AND stage='review' AND "runId" IS NOT NULL AND status IN ('passed','failed','blocked','waiting') ORDER BY position DESC LIMIT 1) review ON true
    LEFT JOIN factory_candidates candidate ON candidate.id=$3 AND candidate."taskId"=$1
    LEFT JOIN run_publications publication ON publication."runId"=candidate."runId" AND publication."userId"=$2
    WHERE current.id=$4 AND current."taskId"=$1 LIMIT 1`, [task.id,task.userId,task.candidateId,task.attemptId]);
  const state = publicFactoryState(task, row);
  const { stage } = state;
  const { rows: history } = await tx.query<{ stage: FactoryTask['stage'] }>(`SELECT stage,min(position) AS position FROM factory_attempts
    WHERE "taskId"=$1 AND ("runId" IS NOT NULL OR id=$2 OR stage IN ('approval','publish','monitor')
      OR (stage='clarify' AND (status='waiting' OR output ? 'resolution' OR output ? 'unresolved')))
    GROUP BY stage ORDER BY min(position) LIMIT 8`,[task.id,task.attemptId]);
  const stages = [...new Set(history.map(a => publicFactoryStage(a.stage, 'pending', false)))];
  if (!stages.includes(stage)) stages.push(stage);
  const verdict = ['passed','changes_requested','needs_judgment'].includes(row?.verdict) ? row.verdict as ReviewVerdict : null;
  return { version: 2, id: task.id, issueId: task.issueId, botId: task.botId, revision: task.revision, ...state, stages,
    review: row?.reviewCandidateId ? { verdict, candidateId: row.reviewCandidateId, currentCandidateReviewed: row.reviewCandidateId === task.candidateId } : null,
    acceptance: row?.artifactId && row.latestVersion ? { artifactId: row.artifactId, version: row.latestVersion, runId: row.reportRunId,
      candidateId: row.reportCandidateId, counts: row.counts, media: row.media } : null,
    pullRequest: row?.pullRequest ?? null };
}
