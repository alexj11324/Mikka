import { factoryEventId } from "./event-id";
import { readIssueMetadata } from "../issue-metadata";
import type { JSONContent } from "@tiptap/core";
import { factoryNextStage, factoryReviewPerformed } from './flow'
import { checkFactoryRepairBudget } from './check-recovery-evidence'
import { assertQuestionExecutionRetry } from './questions/execution-continuation'
import { repositoryExecutionMatches } from './execution-receipt'
import { isDeepStrictEqual } from 'node:util'
import { completeFactoryExecution } from './completed-execution'
import { completedRunForRecovery } from './completion-recovery'
import { unstartedCheckForRecovery, unsubmittedCheckForRecovery, assertRecoveredCheck, type FactoryCheckStartRecovery, type FrozenFactoryCheck } from './check-start-recovery'
import { candidateRecheckForRecovery, candidateRecheckRound, refreshRecheckSource, admitRecheckSource } from './candidate-recheck'
import { retainedDeliverableForRecovery, type ObserveRetainedDeliverable, type ObservedRetainedDeliverable } from './deliverable-recovery'
import { snapshotMatchesScope } from './deliverable-snapshot'
import { apiKeyWorkerDefinition } from "../agent-kit/worker";
import { runPolicySchema } from '@mikka/protocol/agent-policy';
import { intersectRunPolicy } from '../run-assignment-policy';
import { factoryRunBotMatches } from './run-scope'
import { randomUUID } from "node:crypto";
import { factoryChanged } from '../live/factory';
import { factoryCheckIndependent } from "./check-independence";
import { maskFactoryNote } from "./note-mask";
import { factoryTaskDetail, type FactoryTaskDetail } from "./task-detail";
import { readFactoryFlowStates } from './public-flow';
import { publicFactoryTaskSummary, type FactoryPublicTaskSummary } from './public-task';
import { factoryScopeAllows, type FactoryIssueScope } from "./scope";
import { captureIdOf } from "./evidence";
import { escapeLiteral, type Pool, type PoolClient, type QueryResult } from "pg";
import { z } from "zod";
import { daemonTestMode, normalizeRepository, repositoryBindingMatches } from '@mikka/protocol/repository'
import {
  revisionBindingSchema,
  factoryCandidateSchema,
  factoryFlowVersion,
  changeSchema,
  FactoryError,
  routeSchema,
  routeStage,
  type FactoryBinding,
  type FactoryBindingInput,
  type FactoryChange,
  type FactoryStage,
  type FactoryStatus,
} from "./contract";

function isSelectResult(value: unknown): value is Pick<QueryResult, 'command' | 'rows'> {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<QueryResult>;
  return result.command === 'SELECT' && Array.isArray(result.rows)
    && result.rows.every(row => row !== null && typeof row === 'object' && !Array.isArray(row));
}

type ProviderRun = Parameters<typeof import('../run-provider-fallback').providerContinuationMatches>[0]

/** Model changes are authorized by the host receipt. Repository authority
 * remains independently checked, including read-only and no-repository runs
 * which intentionally have no writable publication admission. */
async function providerRepositoryRetryMatches(tx: PoolClient, prior: ProviderRun, retry: ProviderRun) {
  if (prior.agentDefinition?.repositoryAdmission || retry.agentDefinition?.repositoryAdmission)
    return (await import('../run-admission-store')).admittedRepositoryRetryMatches(tx, prior, retry)
  const { rows } = await tx.query(`SELECT r.id,repo."repoPath",repo."remoteUrl",d.kind,b."workspaceId",b."botId"
    FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId" AND repo."deviceId"=r."deviceId"
    JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
    JOIN agents a ON a.id=r."agentId" AND a."userId"=r."userId" AND (a."deviceId"=d.id OR d.kind='cloud')
    LEFT JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    WHERE r.id=ANY($1::uuid[]) AND r."userId"=$2 AND r."issueId"=$3`, [[prior.id, retry.id], prior.userId, prior.issueId])
  const before = rows.find(row => row.id === prior.id), after = rows.find(row => row.id === retry.id)
  if (!before || !after) return false
  if (!before.remoteUrl && !after.remoteUrl)
    return before.kind === 'cloud' && after.kind === 'cloud' && before.repoPath === after.repoPath &&
      Boolean(before.workspaceId && before.botId) && before.workspaceId === after.workspaceId && before.botId === after.botId &&
      before.workspaceId === prior.agentDefinition?.executionIdentity?.workspaceId && after.workspaceId === retry.agentDefinition?.executionIdentity?.workspaceId
  if (prior.agentDefinition?.readOnly !== true || retry.agentDefinition?.readOnly !== true || !before.remoteUrl || !after.remoteUrl) return false
  try {
    const options = { allowFile: daemonTestMode(process.env) }
    return repositoryBindingMatches(before.repoPath, before.remoteUrl, options) && repositoryBindingMatches(after.repoPath, after.remoteUrl, options) &&
      normalizeRepository(before.remoteUrl, options).key === normalizeRepository(after.remoteUrl, options).key
  } catch { return false }
}

export interface FactoryTask {
  id: string;
  userId: string;
  botId: string | null;
  issueId: string;
  workspaceId?: string | null;
  scopeVersion: number | null;
  sourceEventId: string;
  route: z.infer<typeof routeSchema> & { flowVersion?: 2 };
  stage: FactoryStage;
  status: FactoryStatus;
  revision: number;
  attemptId: string;
  candidateId: string | null;
  reason: string;
}

/** Bind a host-created provider continuation before its queue transaction is
 * committed. Otherwise a polling daemon could claim it as a non-Factory run
 * between queue publication and completion reconciliation. */
export async function adoptProviderContinuation(tx: PoolClient, userId: string, sourceRunId: string, retryRunId: string,
  storeFor?: (botId: string | null) => ReturnType<typeof createFactoryStore>) {
  const { rows: bindings } = await tx.query<FactoryTask & { sourceAttemptId: string; requestEpoch: string }>(`SELECT t.*,a.id AS "sourceAttemptId",
    COALESCE(a.output->>'requestEpoch',t."sourceEventId"::text) AS "requestEpoch"
    FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
    WHERE a."runId"=$1 AND t."userId"=$2 ORDER BY t.id FOR UPDATE OF t`, [sourceRunId, userId])
  if (!bindings.length) return 0
  const runtime = storeFor ? null : await import('./runtime')
  const stores = storeFor ?? ((botId: string | null) => runtime!.factoryRuntimeForBot(botId).store)
  const { factoryEventId } = await import('./event-id')
  for (const bound of bindings) {
    if (bound.status !== 'running' || bound.attemptId !== bound.sourceAttemptId || bound.requestEpoch !== bound.sourceEventId)
      throw new FactoryError('factoryStale')
    const store = stores(bound.botId)
    const task = await store.lockTask(tx, userId, bound.id)
    if (task.status !== 'running' || task.attemptId !== bound.sourceAttemptId || task.sourceEventId !== bound.sourceEventId)
      throw new FactoryError('factoryStale')
    await store.apply(userId, { taskId: task.id, issueId: task.issueId, attemptId: task.attemptId, revision: task.revision, candidateId: task.candidateId },
      factoryEventId('adopt-retry', retryRunId), { action: 'adopt_retry', runId: retryRunId, reason: 'Continue with the next preferred model after the provider failed' }, tx)
  }
  return bindings.length
}

export type FactoryTaskSummary = Pick<FactoryTask, "id" | "issueId" | "stage" | "status" | "revision" | "attemptId" | "candidateId" | "reason"> & {
  isSkillCandidate: boolean;
  /** The run that produced the candidate, so acceptance can sit beside its thread. */
  candidateRunId: string | null;
  /** Commit of the current candidate, so a card can tell a stale approval apart without the ledger. */
  candidateSha: string | null;
  /** Latest publication for the current candidate, if any. */
  publication: FactoryPublicationSummary | null;
  /** Host-confirmed completed execution or retained delivery that can enter fresh checks. */
  completionRecovery?: { binding: { taskId: string; revision: number } };
};
/** Same status union as #441's AcceptancePublication (lib/factory/acceptance-state.ts). */
export type FactoryPublicationStatus = "reserved" | "uncertain" | "succeeded" | "failed";
export interface FactoryPublicationSummary {
  id: string;
  approvalId: string;
  status: FactoryPublicationStatus;
  action: string;
  target: string;
  /** ISO 8601 UTC, e.g. 2026-10-30T05:00:00.000Z */
  createdAt: string;
  finishedAt: string | null;
}
type PublicationRow = Omit<FactoryPublicationSummary, "createdAt" | "finishedAt"> & { createdAt: string; finishedAt: string | null };
function publicationSummary(row: PublicationRow | null): FactoryPublicationSummary | null {
  if (!row) return null;
  return { ...row, createdAt: new Date(row.createdAt).toISOString(), finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null };
}
export interface FactoryAttempt {
  id: string;
  taskId: string;
  stage: FactoryStage;
  ordinal: number;
  position: number;
  status: FactoryStatus;
  candidateId: string | null;
  runId: string | null;
  sessionId: string | null;
  reason: string;
  output: Record<string, unknown>;
  evidence: unknown[];
}
export interface FactoryCandidate {
  id: string;
  taskId: string;
  sha: string | null;
  kind?: 'repository' | 'report' | 'deliverable';
  repository: string;
  environment: string;
  scope: string;
  runId: string;
}
export interface FactorySnapshot {
  contractVersion: 1;
  task: FactoryTask;
  attempts: FactoryAttempt[];
  candidates: FactoryCandidate[];
}
/** A store-owned issue snapshot from the same APP transaction. GETs use MVCC;
 * write callers lock their own rows. This replaces a second issue read, never
 * the current membership check. */
export type FactoryLockedIssue = FactoryIssueScope & { id: string; deleted: boolean };
export type FactoryAuthorize = (
  userId: string,
  issueId: string,
  tx: PoolClient,
  lockedIssue?: Readonly<FactoryLockedIssue>,
) => Promise<boolean>;
const completionRecoveryAuthority = Symbol('owner-completion-recovery');
type CompletionRecoveryAuthority = { [completionRecoveryAuthority]: true; tx: PoolClient; userId: string; taskId: string; attemptId: string; sourceEventId: string; runId: string };
const questionRetryAuthority = Symbol('question-execution-retry');
type QuestionRetryAuthority = { [questionRetryAuthority]: true; tx: PoolClient; userId: string; taskId: string; attemptId: string; sourceEventId: string; runId: string };
const checkStartRetryAuthority = Symbol('owner-check-start-retry');
type CheckStartRetryAuthority = { [checkStartRetryAuthority]: true; kind: FactoryCheckStartRecovery['kind']; tx: PoolClient; userId: string; taskId: string; attemptId: string; candidateId: string; sourceEventId: string; runId: string };
export type FactoryCompletionDispatch = (tx: PoolClient, store: ReturnType<typeof createFactoryStore>, task: FactoryTask, run: Record<string, any>, checkStart?: FrozenFactoryCheck) => Promise<(() => Promise<void>) | undefined>;
export type FactoryGate = (
  tx: PoolClient,
  task: FactoryTask,
  attempt: FactoryAttempt,
  change: Extract<FactoryChange, { action: "finish" }>,
) => Promise<boolean>;
export type FactoryGates = Partial<
  Record<"review" | "verify" | "approval" | "publish" | "monitor", FactoryGate>
>;
/** Host-installed callbacks run inside the authorized task transaction. */
export interface FactoryLifecycle {
  gates?: FactoryGates;
  onTransition?: (tx: PoolClient, task: FactoryTask) => Promise<void>;
  independent?: (tx: PoolClient, task: FactoryTask, runId: string) => Promise<boolean>;
}
const terminal = (task: FactoryTask) =>
  task.status === "cancelled" || task.status === "revoked";
function fail(code: string): never {
  throw new FactoryError(code);
}
const uuid = (value: string) => {
  if (!z.uuid().safeParse(value).success) fail("factoryInvalid");
};

/** No queues, timers or Harness: just transactional state on the existing application pool. */
export function createFactoryStore(
  pool: Pool,
  authorize: FactoryAuthorize,
  botIdOrGates: string | null | FactoryGates = null,
  lifecycle?: FactoryLifecycle,
) {
  const botId = typeof botIdOrGates === "string" ? botIdOrGates : null;
  if (botIdOrGates && typeof botIdOrGates === "object") lifecycle = { independent: factoryCheckIndependent, ...lifecycle, gates: { ...botIdOrGates, ...lifecycle?.gates } };
  async function transaction<T>(
    fn: (tx: PoolClient) => Promise<T>,
    existing?: PoolClient,
  ): Promise<T> {
    // #191 can enqueue and bind on its already-open transaction. Its caller
    // owns BEGIN/COMMIT/ROLLBACK; an error must roll back the entire dispatch.
    if (existing) return fn(existing);
    const { beginFactoryTransaction, commitFactoryTransaction, rollbackFactoryTransaction, forgetFactoryTransaction } = await import('./transaction');
    const tx = await pool.connect();
    try {
      await beginFactoryTransaction(tx);
      const result = await fn(tx);
      await commitFactoryTransaction(tx);
      return result;
    } catch (error) {
      await rollbackFactoryTransaction(tx);
      throw error;
    } finally {
      forgetFactoryTransaction(tx); tx.release();
    }
  }
  async function allowedSource(
    tx: PoolClient,
    userId: string,
    eventId: string,
    issueId: string,
    lock = true,
    sourceBotId = botId,
    withPayload = false,
  ) {
    const { rows } = await tx.query(
      // A null-Bot source can still be considered by Coordinator backfill.
      // Keep the validated execution scope until this write transaction ends;
      // a source moved before this lock is acquired must fail the predicate.
      `SELECT e.id${withPayload ? ',e.payload' : ''} FROM coordinator_events e WHERE e.id=$1 AND e."userId"=$2 AND e.kind='user_message' AND e."botId" IS NOT DISTINCT FROM $3::uuid AND (e."issueId" IS NULL OR e."issueId"=$4) AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM bots b WHERE b.id=$3 AND b."ownerId"=$2))${lock && sourceBotId === null ? ' FOR SHARE OF e' : ''}`,
      [eventId, userId, sourceBotId, issueId],
    );
    return rows.length === 1 ? rows[0] : undefined;
  }
  async function sourceAllowed(tx: PoolClient, userId: string, eventId: string, issueId: string, lock = true, sourceBotId = botId) {
    return Boolean(await allowedSource(tx, userId, eventId, issueId, lock, sourceBotId));
  }
  /** lock=false is the read-only variant for GETs: same ownership/scope checks, no row locks. */
  async function owned(tx: PoolClient, userId: string, taskId: string, lock = true, readScope: "bot" | "user" = "bot") {
    uuid(taskId);
    const {
      rows: [task],
    } = await tx.query<FactoryTask>(
      lock
        ? 'SELECT * FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR UPDATE'
        : 'SELECT * FROM factory_tasks WHERE id=$1 AND "userId"=$2',
      [taskId, userId],
    );
    const issue = task ? await lockedIssue(tx, task.issueId, lock) : undefined;
    if (
      !task ||
      (task.botId !== botId && (lock || readScope === "bot")) ||
      !factoryScopeAllows(task, issue) ||
      !(await authorize(userId, task.issueId, tx)) ||
      !(await sourceAllowed(tx, userId, task.sourceEventId, task.issueId, lock, task.botId))
    )
      fail("factoryNotFound");
    return task;
  }
  async function lockedIssue(tx: PoolClient, issueId: string, lock = true) {
    const { rows: [issue] } = await tx.query<FactoryIssueScope>(lock ? 'SELECT "userId",scope,"scopeVersion","workspaceId","ownershipState" FROM issues WHERE id=$1 FOR SHARE' : 'SELECT "userId",scope,"scopeVersion","workspaceId","ownershipState" FROM issues WHERE id=$1', [issueId]);
    return issue;
  }
  async function snapshot(
    tx: PoolClient,
    task: FactoryTask,
  ): Promise<FactorySnapshot> {
    // Keep both SELECT statements and native pg types in one round trip.
    const taskId = escapeLiteral(task.id);
    const result: unknown = await tx.query(`SELECT * FROM factory_attempts WHERE "taskId"=${taskId} ORDER BY position;
      SELECT * FROM factory_candidates WHERE "taskId"=${taskId} ORDER BY "createdAt"`);
    if (!Array.isArray(result) || result.length !== 2 || !result.every(isSelectResult)) throw new TypeError('Invalid Factory snapshot');
    const attempts = result[0].rows as FactoryAttempt[];
    const candidates = result[1].rows as FactoryCandidate[];
    // Return the same JSON representation on the first call and durable replay.
    return JSON.parse(
      JSON.stringify({ contractVersion: 1, task, attempts, candidates }),
    ) as FactorySnapshot;
  }
  /** Read-only hint for ordinary Owner retry, never a new execution grant.
   * The no-run observation is distinct from recovery of a frozen failed Run. */
  async function checkDispatchRecovery(tx: PoolClient, value: FactorySnapshot) {
    const { task, attempts, candidates } = value;
    const attempt = attempts.find(row => row.id === task.attemptId);
    if (task.status !== 'blocked' || !['review', 'verify'].includes(task.stage) || !task.candidateId ||
        !attempt || attempt.taskId !== task.id || attempt.stage !== task.stage || attempt.status !== 'blocked' ||
        attempt.candidateId !== task.candidateId || attempt.runId !== null || attempt.sessionId !== null ||
        attempt.output?.requestEpoch !== task.sourceEventId || attempt.evidence.length !== 0 ||
        !isDeepStrictEqual(attempt.output.dispatch, { code: 'agentProfileDecisionUnavailable' }) ||
        !candidates.some(candidate => candidate.id === task.candidateId && candidate.taskId === task.id)) return undefined;
    const { rows: [observation] } = await tx.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2',
      [task.id, factoryEventId('check-dispatch-decision-unavailable', task.attemptId)]);
    const change = observation?.request?.change;
    const recorded = observation?.result?.task;
    if (change?.action !== 'finish' || change.status !== 'blocked' || !isDeepStrictEqual(change.evidence, []) ||
        !isDeepStrictEqual(change.output, { dispatch: { code: 'agentProfileDecisionUnavailable' } }) ||
        !recorded || (['id', 'userId', 'botId', 'issueId', 'sourceEventId', 'stage', 'status', 'revision', 'attemptId', 'candidateId'] as const)
          .some(key => recorded[key] !== task[key])) return undefined;
    if (task.stage === 'review' && factoryFlowVersion(task) === 2 && await factoryReviewPerformed(tx, task)) return undefined;
    const { rows: [blocked] } = await tx.query(`SELECT
      EXISTS(SELECT 1 FROM factory_questions WHERE "taskId"=$1 AND status NOT IN ('resolved','cancelled','expired','superseded')) AS question,
      EXISTS(SELECT 1 FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId"
        WHERE a."taskId"=$1 AND r.status NOT IN ('succeeded','completed','failed','stopped','cancelled')) AS active`, [task.id]);
    if (blocked.question || blocked.active) return undefined;
    return { binding: { taskId: task.id, revision: task.revision } };
  }
  async function replay(
    tx: PoolClient,
    taskId: string,
    eventId: string,
    request: unknown,
  ) {
    const {
      rows: [event],
    } = await tx.query<{ result: FactorySnapshot; same: boolean }>(
      `SELECT result, CASE WHEN request ? 'binding' AND $3::jsonb ? 'binding'
        THEN (request-'binding')=($3::jsonb-'binding')
          AND request->'binding'->>'taskId'=$3::jsonb->'binding'->>'taskId'
          AND request->'binding'->>'revision'=$3::jsonb->'binding'->>'revision'
        ELSE request=$3::jsonb END AS same
        FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2`,
      [taskId, eventId, JSON.stringify(request)],
    );
    if (event && !event.same) fail("factoryReplayMismatch");
    return event?.result;
  }
  async function save(
    tx: PoolClient,
    task: FactoryTask,
    eventId: string,
    request: unknown,
  ) {
    const result = await snapshot(tx, task);
    await tx.query(
      'INSERT INTO factory_events ("taskId","eventId",request,result) VALUES ($1,$2,$3,$4)',
      [task.id, eventId, JSON.stringify(request), JSON.stringify(result)],
    );
    await lifecycle?.onTransition?.(tx, task);
    await factoryChanged(tx, task);
    return result;
  }
  async function runFor(tx: PoolClient, task: FactoryTask, runId: string) {
    const {
      rows: [run],
    } = await tx.query(
      'SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR UPDATE',
      [runId, task.userId, task.issueId],
    );
    if (!run || run.stopRequestedAt || !(await factoryRunBotMatches(tx, task, run))) fail("factoryRunMismatch");
    return run;
  }
  async function freshAttempt(
    tx: PoolClient,
    task: FactoryTask,
    stage: FactoryStage,
    reason: string,
  ) {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"candidateId",reason,output)
      SELECT $1,$2,$3,coalesce(max(ordinal) FILTER (WHERE stage=$3),0)+1,coalesce(max(position),0)+1,'pending',$4,$5,$6 FROM factory_attempts WHERE "taskId"=$2`,
      [id, task.id, stage, task.candidateId, reason, JSON.stringify({ requestEpoch: task.sourceEventId })],
    );
    task.attemptId = id;
    task.stage = stage;
    task.status = "pending";
  }

  type IssueList<T> = { contractVersion: 1; issueId: string; tasks: T[] };
  async function listIssueTasks(userId: string, issueId: string, anyBot: boolean, publicFlow: false): Promise<IssueList<FactoryTaskSummary>>;
  async function listIssueTasks(userId: string, issueId: string, anyBot: boolean, publicFlow: true): Promise<IssueList<FactoryTaskSummary | FactoryPublicTaskSummary>>;
  async function listIssueTasks(userId: string, issueId: string, anyBot: boolean, publicFlow: boolean): Promise<IssueList<FactoryTaskSummary | FactoryPublicTaskSummary>> {
    uuid(issueId);
    return transaction(async (tx) => {
      if (publicFlow) await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const { rows: [issue] } = await tx.query<FactoryLockedIssue & { content: JSONContent }>(
        `SELECT id,"userId",scope,"scopeVersion","workspaceId","ownershipState",
          jsonb_build_object('type','doc','attrs',content->'attrs') AS content,
          coalesce(content->'attrs'->'mikka',content->'attrs'->'orvilo')->>'deletedAt' IS NOT NULL AS deleted
          FROM issues WHERE id=$1`, [issueId],
      );
      // Preserve both halves of issueForUser's deletion check, including a
      // JSON-null mikka key whose legacy orvilo metadata still has a tombstone.
      if (issue) issue.deleted ||= Boolean(readIssueMetadata(issue.content).deletedAt);
      if (!issue || !(await authorize(userId, issueId, tx, issue))) fail("factoryNotFound");
      // The newest 50 count every task of the issue; the issue's current scope then decides which are listed.
      const { rows } = await tx.query<FactoryTask & { isSkillCandidate: boolean; candidateRunId: string | null; candidateSha: string | null; publication: PublicationRow | null; inScope: boolean }>(
        'SELECT t.*, c."runId" AS "candidateRunId", c.sha AS "candidateSha", (SELECT json_build_object(\'id\',p.id,\'approvalId\',p."approvalId",\'status\',p.status,\'action\',p.action,\'target\',p.target,\'createdAt\',p."createdAt",\'finishedAt\',p."finishedAt") FROM factory_publications p WHERE p."taskId"=t.id AND p."candidateId"=t."candidateId" ORDER BY p."createdAt" DESC,p.id DESC LIMIT 1) AS publication, EXISTS (SELECT 1 FROM improvement_skill_candidates s WHERE s."factoryTaskId"=t.id AND s."candidateId"=t."candidateId" AND s."userId"=t."userId") AS "isSkillCandidate", (i."ownershipState"=\'bound\' AND t."workspaceId"=i."workspaceId") AS "inScope" FROM factory_tasks t JOIN issues i ON i.id=t."issueId" LEFT JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id WHERE t."userId"=$1 AND t."issueId"=$2 AND ($4::boolean OR (t."botId" IS NOT DISTINCT FROM $3::uuid AND (i."ownershipState"=\'bound\' AND t."workspaceId"=i."workspaceId"))) ORDER BY t."updatedAt" DESC,t.id DESC LIMIT 50',
        [userId, issueId, botId, anyBot],
      );
      const listed = rows.filter(row => row.inScope && factoryScopeAllows(row, issue));
      // Each task's source message, from its own Bot's chat (or the unscoped chat), in one read.
      const sources = listed.some(row => row.sourceEventId) ? (await tx.query<{ id: string; botId: string | null }>(
        `SELECT e.id,e."botId" FROM coordinator_events e WHERE e.id=ANY($1::uuid[]) AND e."userId"=$2 AND e.kind='user_message' AND (e."issueId" IS NULL OR e."issueId"=$3) AND (e."botId" IS NULL OR EXISTS (SELECT 1 FROM bots b WHERE b.id=e."botId" AND b."ownerId"=$2))`,
        [[...new Set(listed.flatMap(row => row.sourceEventId ? [row.sourceEventId] : []))], userId, issueId],
      )).rows : [];
      const authorized = listed.filter(row => sources.some(source => source.id === row.sourceEventId && source.botId === (row.botId ?? null)));
      const states = await readFactoryFlowStates(tx, publicFlow ? authorized.filter(row => factoryFlowVersion(row) === 2) : []);
      const tasks: (FactoryTaskSummary | FactoryPublicTaskSummary)[] = [];
      for (const row of authorized) {
        const state = states.get(row.id);
        if (state) {
          tasks.push(publicFactoryTaskSummary(row, state, row));
          continue;
        }
        const { id, issueId, stage, status, revision, attemptId, candidateId, reason, isSkillCandidate, candidateRunId, candidateSha, publication } = row;
        const completionRecovery = (await completedRunForRecovery(tx, row)) || (await retainedDeliverableForRecovery(tx, row)) ? { binding: { taskId: id, revision } } : undefined;
        tasks.push({id,issueId,stage,status,revision,attemptId,candidateId,reason:maskFactoryNote(reason),isSkillCandidate,candidateRunId,candidateSha:candidateSha ?? null,publication:publicationSummary(publication),...(completionRecovery ? { completionRecovery } : {})});
      }
      return { contractVersion: 1 as const, issueId, tasks };
    });
  }
  const store = {
    lockTask: (tx: PoolClient, userId: string, taskId: string) => owned(tx, userId, taskId),
    /** Read-only GET paths: ownership/scope checked, nothing locked. */
    readTask: (tx: PoolClient, userId: string, taskId: string) => owned(tx, userId, taskId, false),
    /** Human question collections span the user's Bots; the actual task's source and issue ACL still apply. */
    readTaskForUser: (tx: PoolClient, userId: string, taskId: string) => owned(tx, userId, taskId, false, "user"),
    async route(userId: string, input: unknown, existing?: PoolClient) {
      const parsed = routeSchema.safeParse(input);
      if (!parsed.success) fail("factoryInvalid");
      const route = parsed.data;
      return transaction(async (tx) => {
        // Owner/issue lock serializes competing routes before a task row exists.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          JSON.stringify([userId, route.issueId]),
        ]);
        // Replays take task -> issue, like cancellation/dispatch. New routes
        // freeze the issue generation under the same issue lock before INSERT.
        const { rows: [prior] } = await tx.query<FactoryTask>(
          `SELECT t.* FROM factory_tasks t WHERE t."userId"=$1 AND t."issueId"=$2 AND
            (t."sourceEventId"=$3::uuid OR EXISTS(SELECT 1 FROM factory_events e WHERE e."taskId"=t.id
              AND (e.request->>'sourceEventId'=($3::uuid)::text OR e.result->'task'->>'sourceEventId'=($3::uuid)::text))
              OR EXISTS(SELECT 1 FROM coordinator_events s JOIN factory_attempts a ON a."taskId"=t.id
                AND a."runId"::text=s.payload->>'previousRunId'
                WHERE s.id=$3 AND s.payload->>'source'='thread_continuation'))
            ORDER BY (t."sourceEventId"=$3::uuid) DESC,t."createdAt" DESC LIMIT 1 FOR UPDATE OF t`,
          [userId, route.issueId, route.sourceEventId],
        );
        const issue = await lockedIssue(tx, route.issueId);
        if (!issue || issue.ownershipState !== 'bound' || !issue.workspaceId || !(await authorize(userId, route.issueId, tx))) fail("factoryNotFound");
        if (prior && !factoryScopeAllows(prior, issue)) fail("factoryNotFound");
        const source = await allowedSource(tx, userId, route.sourceEventId, route.issueId, true, botId, true);
        if (!source) fail("factorySourceMismatch");
        if (prior) {
          if (prior.botId !== botId) fail("factoryNotFound");
          if (prior.sourceEventId !== route.sourceEventId) {
            if (source.payload?.source !== 'thread_continuation') fail("factoryStale");
            const { advanceFactoryRequest } = await import('./request-epoch');
            return save(tx, await advanceFactoryRequest(tx, prior, route.sourceEventId), route.eventId, route);
          }
          if (terminal(prior)) fail("factoryStopped");
          return (
            (await replay(tx, prior.id, route.eventId, route)) ??
            fail("factoryRouteExists")
          );
        }
        const task: FactoryTask = {
          id: randomUUID(),
          userId,
          botId,
          issueId: route.issueId,
          workspaceId: issue.workspaceId,
          scopeVersion: issue.scopeVersion,
          sourceEventId: route.sourceEventId,
          route: { ...route, flowVersion: 2 },
          stage: routeStage(route),
          status: routeStage(route) === "clarify" ? "waiting" : "pending",
          revision: 1,
          attemptId: randomUUID(),
          candidateId: null,
          reason: route.rationale,
        };
        await tx.query(
          `INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId",route,stage,status,revision,"attemptId",reason,"botId","scopeVersion","workspaceId") VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12)`,
          [
            task.id,
            userId,
            task.issueId,
            task.sourceEventId,
            JSON.stringify(task.route),
            task.stage,
            task.status,
            task.attemptId,
            task.reason,
            botId,
            task.scopeVersion,
            task.workspaceId,
          ],
        );
        await tx.query(
          'INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,reason,output) VALUES ($1,$2,$3,1,1,$4,$5,$6)',
          [task.attemptId, task.id, task.stage, task.status, task.reason, JSON.stringify({ requestEpoch: task.sourceEventId })],
        );
        return save(tx, task, route.eventId, route);
      }, existing);
    },
    /** Task-detail GET: read-only, no row locks (BE-16). B8/B9 checks and the B11 header are computed, never stored. */
    async read(userId: string, taskId: string): Promise<FactorySnapshot & Partial<FactoryTaskDetail> & { completionRecovery?: { binding: { taskId: string; revision: number } }; checkStartRecovery?: { binding: { taskId: string; revision: number } }; checkSubmissionRecovery?: { binding: { taskId: string; revision: number } }; checkDispatchRecovery?: { binding: { taskId: string; revision: number } }; candidateRecheck?: { binding: { taskId: string; revision: number } } }> {
      return transaction(async (tx) => {
        const task = await owned(tx, userId, taskId, false);
        const value = await snapshot(tx, task);
        const dispatchRecovery = await checkDispatchRecovery(tx, value);
        return {
          ...value,
          ...(await factoryTaskDetail(tx, task)),
          ...((await completedRunForRecovery(tx, task)) || (await retainedDeliverableForRecovery(tx, task)) ? { completionRecovery: { binding: { taskId: task.id, revision: task.revision } } } : {}),
          ...(await unstartedCheckForRecovery(tx, task) ? { checkStartRecovery: { binding: { taskId: task.id, revision: task.revision } } } : {}),
          ...(await unsubmittedCheckForRecovery(tx, task) ? { checkSubmissionRecovery: { binding: { taskId: task.id, revision: task.revision } } } : {}),
          ...(dispatchRecovery ? { checkDispatchRecovery: dispatchRecovery } : {}),
          ...(await candidateRecheckForRecovery(tx, task) ? { candidateRecheck: { binding: { taskId: task.id, revision: task.revision } } } : {}),
        };
      });
    },
    /** Explicit Owner operation, absent from the runtime/model change schema.
     * Append a new independent review without editing any earlier verdict.
     * Its host receipt also pins the subsequent verify to its own old source. */
    async recheckCandidate(userId: string, rawBinding: FactoryBindingInput, eventId: string, reason: string, dispatch?: FactoryCompletionDispatch): Promise<{ result: FactorySnapshot; start?: () => Promise<void> }> {
      const binding = revisionBindingSchema.parse(rawBinding);
      const retry = changeSchema.parse({ action: 'retry', reason });
      if (retry.action !== 'retry') fail('factoryInvalid');
      const change = { action: 'recheck', reason: retry.reason };
      uuid(eventId);
      const receiptFor = async (tx: PoolClient, task: FactoryTask) => {
        const { rows: [receipt] } = await tx.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id,eventId]);
        if (!receipt) return null;
        if (receipt.request.kind !== 'owner_candidate_recheck' || !isDeepStrictEqual(receipt.request.input, { binding, change })) fail('factoryReplayMismatch');
        if (receipt.request.sourceEventId !== task.sourceEventId) fail('factoryStale');
        return receipt.result as FactorySnapshot;
      };
      const prepared = await transaction(async tx => {
        const task = await owned(tx, userId, binding.taskId, false);
        if (terminal(task)) fail('factoryStopped');
        const result = await receiptFor(tx, task);
        if (result) return { result };
        if (task.revision !== binding.revision) fail('factoryStale');
        const recovery = await candidateRecheckForRecovery(tx, task);
        if (!recovery) fail('factoryCheckBindingMismatch');
        return { recovery };
      });
      if (prepared.result) return { result: prepared.result };
      if (!dispatch) fail('factoryDispatchAdapterRequired');
      const observed = prepared.recovery!;
      await refreshRecheckSource(pool, observed.review);
      await refreshRecheckSource(pool, observed.verify);
      return transaction(async tx => {
        const task = await owned(tx, userId, binding.taskId);
        if (terminal(task)) fail('factoryStopped');
        const replayed = await receiptFor(tx, task);
        if (replayed) return { result: replayed };
        if (task.revision !== binding.revision) fail('factoryStale');
        const recovery = await candidateRecheckForRecovery(tx, task, true);
        if (!recovery || recovery.review.run.id !== observed.review.run.id || recovery.verify.run.id !== observed.verify.run.id ||
            !isDeepStrictEqual(recovery.review.selection, observed.review.selection) ||
            !isDeepStrictEqual(recovery.verify.selection, observed.verify.selection)) fail('factoryCheckBindingMismatch');
        if (!isDeepStrictEqual(recovery.question, observed.question)) fail('factoryStale');
        await admitRecheckSource(tx, recovery.review);
        await admitRecheckSource(tx, recovery.verify);
        if (recovery.question && recovery.question.status !== 'expired') {
          const expired = recovery.question.disposition === 'expired';
          const updated = await tx.query(`UPDATE factory_questions SET status=$3,reason=$4,revision=revision+1,"updatedAt"=now()
            WHERE id=$1 AND revision=$2 AND status IN ('open','waiting_user') AND "answerId" IS NULL AND "continuationRunId" IS NULL
              AND "answerSource" IS NULL AND "answerSourceEventId" IS NULL AND "answerFingerprint" IS NULL AND "answeredAt" IS NULL
              AND answer IS NULL AND result IS NULL
              AND CASE WHEN $3='expired' THEN "expiresAt"<=clock_timestamp()
                ELSE "expiresAt" IS NULL OR "expiresAt">clock_timestamp() END`,
            [recovery.question.id, recovery.question.revision, recovery.question.disposition,
              expired ? 'Question expired; continuation is not authorized' : change.reason]);
          if (updated.rowCount !== 1) fail('factoryStale');
        }
        const candidateId = task.candidateId, sourceEventId = task.sourceEventId;
        await freshAttempt(tx, task, 'review', change.reason);
        await tx.query(`UPDATE factory_attempts SET output=output || $2::jsonb WHERE id=$1`, [task.attemptId, JSON.stringify({ ownerRecheckEventId: eventId })]);
        task.reason = change.reason; task.revision++;
        await tx.query(`UPDATE factory_tasks SET stage='review',status='pending',revision=$2,"attemptId"=$3,reason=$4,"updatedAt"=now() WHERE id=$1`,
          [task.id, task.revision, task.attemptId, task.reason]);
        const start = await dispatch(tx, store, task, recovery.review.run, recovery.review);
        const final = await owned(tx, userId, task.id);
        if (!start || final.stage !== 'review' || final.status !== 'running' || final.revision !== binding.revision + 2 ||
            final.candidateId !== candidateId || final.sourceEventId !== sourceEventId || final.attemptId !== task.attemptId) fail('factoryCheckBindingMismatch');
        const { rows: [queued] } = await tx.query(`SELECT r.*,a.output->'check' AS "checkAssignment" FROM factory_attempts a
          JOIN agent_runs r ON r.id=a."runId" WHERE a.id=$1 AND a."taskId"=$2 AND a.status='running'`, [final.attemptId,task.id]);
        if (!queued) fail('factoryCheckBindingMismatch');
        assertRecoveredCheck(recovery.review, queued, queued.checkAssignment);
        const result = await save(tx, final, eventId, { kind: 'owner_candidate_recheck', input: { binding, change }, sourceEventId, candidateId,
          reviewAttemptId: final.attemptId, reviewRunId: queued.id,
          sources: { review: { attemptId: recovery.review.attemptId, runId: recovery.review.run.id }, verify: { attemptId: recovery.verify.attemptId, runId: recovery.verify.run.id } },
          questionDisposition: recovery.question ? { id: recovery.question.id, revision: recovery.question.revision,
            fromStatus: recovery.question.status, toStatus: recovery.question.disposition } : null });
        return { result, start };
      }).catch(async error => {
        const { AgentProfileError } = await import('./agent-profile');
        const { AgentProfileAdmissionError } = await import('./profile-admission');
        if (error instanceof AgentProfileError || error instanceof AgentProfileAdmissionError) throw new FactoryError('agentProfileUnavailable', { cause: error });
        throw error;
      });
    },
    /** Owner retry of a host-qualified unstarted or unsubmitted check. Refresh only
     * its frozen source outside write locks; queue, binding and receipt commit
     * together under the original task/epoch and current admission fences. */
    async retryCheckStart(userId: string, rawBinding: FactoryBindingInput, eventId: string, reason: string, dispatch?: FactoryCompletionDispatch): Promise<{ result: FactorySnapshot; start?: () => Promise<void> } | null> {
      const binding = revisionBindingSchema.parse(rawBinding);
      const change = changeSchema.parse({ action: 'retry', reason });
      uuid(eventId);
      const receiptFor = async (tx: PoolClient, task: FactoryTask) => {
        const { rows: [receipt] } = await tx.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id,eventId]);
        if (!receipt || !['owner_check_start_recovery', 'owner_check_submission_recovery'].includes(receipt.request.kind)) return null;
        if (!isDeepStrictEqual(receipt.request.input, { binding, change })) fail('factoryReplayMismatch');
        if (receipt.request.sourceEventId !== task.sourceEventId) fail('factoryStale');
        return receipt.result as FactorySnapshot;
      };
      const prepared = await transaction<{ result: FactorySnapshot } | { recovery: FactoryCheckStartRecovery } | null>(async tx => {
        const task = await owned(tx, userId, binding.taskId, false);
        if (terminal(task)) fail('factoryStopped');
        const result = await receiptFor(tx, task);
        if (result) return { result };
        // Leave other retry kinds and their durable replay semantics unchanged.
        const other = await tx.query('SELECT 1 FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id,eventId]);
        if (other.rowCount) return null;
        if (task.revision !== binding.revision) fail('factoryStale');
        const recovery = await unstartedCheckForRecovery(tx, task) ?? await unsubmittedCheckForRecovery(tx, task);
        return recovery ? { recovery } : null;
      });
      if (!prepared) return null;
      if ('result' in prepared) return { result: prepared.result };
      if (!dispatch) fail('factoryDispatchAdapterRequired');
      const { recovery: observed } = prepared;
      const { refreshProfileQuota, AgentProfileAdmissionError } = await import('./profile-admission');
      await refreshProfileQuota(pool, {
        ownerId: userId, workspaceId: observed.run.agentDefinition.executionIdentity.workspaceId,
        agentId: observed.run.agentId, model: observed.selection.model,
        subscriptionBindingId: observed.selection.subscriptionBindingId, selection: observed.selection.agentProfile,
      });
      return transaction(async tx => {
        const task = await owned(tx, userId, binding.taskId);
        if (terminal(task)) fail('factoryStopped');
        const replayed = await receiptFor(tx, task);
        if (replayed) return { result: replayed };
        if (task.revision !== binding.revision) fail('factoryStale');
        const recovery = await unstartedCheckForRecovery(tx, task, true) ?? await unsubmittedCheckForRecovery(tx, task, true);
        if (!recovery || recovery.kind !== observed.kind || recovery.run.id !== observed.run.id) fail('factoryCheckBindingMismatch');
        await runFor(tx, task, recovery.run.id);
        // Frozen selection skips the resolver, but still participates in the
        // existing final Profile/source and membership checks at real COMMIT.
        (await import('./transaction')).registerFactoryProfile(tx,
          { ownerId: userId, workspaceId: recovery.run.agentDefinition.executionIdentity.workspaceId }, recovery.selection.agentProfile);
        const authority: CheckStartRetryAuthority = { [checkStartRetryAuthority]: true, kind: recovery.kind, tx, userId,
          taskId: task.id, attemptId: task.attemptId, candidateId: recovery.candidateId, sourceEventId: task.sourceEventId, runId: recovery.run.id };
        const next = await store.apply(userId, binding, factoryEventId('owner-check-start-retry', eventId), change, tx, undefined, undefined, authority);
        const start = await dispatch(tx, store, next.task, recovery.run, recovery);
        const final = await owned(tx, userId, task.id);
        if (!start || final.stage !== task.stage || final.status !== 'running' || final.revision !== binding.revision + 2 ||
            final.candidateId !== task.candidateId || final.sourceEventId !== task.sourceEventId || final.attemptId === task.attemptId) fail('factoryCheckBindingMismatch');
        const { rows: [queued] } = await tx.query(`SELECT r.*,a.output->'check' AS "checkAssignment" FROM factory_attempts a
          JOIN agent_runs r ON r.id=a."runId" WHERE a.id=$1 AND a."taskId"=$2 AND a.status='running'`, [final.attemptId,task.id]);
        if (!queued) fail('factoryCheckBindingMismatch');
        assertRecoveredCheck(recovery, queued, queued.checkAssignment);
        const result = await save(tx, final, eventId, { kind: recovery.kind === 'unsubmitted' ? 'owner_check_submission_recovery' : 'owner_check_start_recovery', input: { binding, change },
          sourceEventId: task.sourceEventId, attemptId: authority.attemptId, candidateId: task.candidateId, runId: recovery.run.id });
        return { result, start };
      }).catch(async error => {
        // These known admission refusals are deterministic rollbacks, not an
        // unknown POST outcome. Keep diagnostics on the server; never turn a
        // database/provider failure or an arbitrary 409 into a safe retry claim.
        if (error instanceof AgentProfileAdmissionError) throw new FactoryError('agentProfileUnavailable', { cause: error });
        const { ComputerError } = await import('../computer/store');
        if (error instanceof ComputerError && error.status === 409) {
          if (['Bot subscription unavailable', 'agentProfileUnavailable'].includes(error.message))
            throw new FactoryError('agentProfileUnavailable', { cause: error });
          if (['Bot computer task is unavailable', 'Execution identity or resource unavailable'].includes(error.message))
            throw new FactoryError('factoryCheckHarnessUnavailable', { cause: error });
        }
        throw error;
      });
    },
    /** Human Retry only: consume the current successful run without rewriting its blocked attempt.
     * The run/attempt/epoch remain locked; provider work is returned for after COMMIT. */
    async retryCompletion(userId: string, rawBinding: FactoryBindingInput, eventId: string, reason: string, dispatch?: FactoryCompletionDispatch): Promise<{ result: FactorySnapshot; start?: () => Promise<void> } | null> {
      const binding = revisionBindingSchema.parse(rawBinding);
      const change = changeSchema.parse({ action: 'retry', reason });
      uuid(eventId);
      return transaction(async tx => {
        const task = await owned(tx, userId, binding.taskId);
        if (terminal(task)) fail('factoryStopped');
        const { rows: [receipt] } = await tx.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id,eventId]);
        if (receipt) {
          if (receipt.request.kind !== 'owner_completion_recovery') return null;
          if (!isDeepStrictEqual(receipt.request.input, { binding, change })) fail('factoryReplayMismatch');
          if (receipt.request.sourceEventId !== task.sourceEventId) fail('factoryStale');
          return { result: receipt.result };
        }
        if (task.revision !== binding.revision) fail('factoryStale');
        const run = await completedRunForRecovery(tx, task, true);
        if (!run) {
          // A denied completion recovery must not fall through to a fresh producer.
          if (task.stage === 'execute' && task.status === 'blocked') {
            const { rowCount } = await tx.query(`SELECT 1 FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId"
              WHERE a.id=$1 AND a."taskId"=$2 AND a.output->'watchdog'->>'reasonCode'='recovery_exhausted' AND r.status='succeeded'`, [task.attemptId,task.id]);
            if (rowCount) fail('factoryCompletionRecoveryUnavailable');
          }
          return null;
        }
        await runFor(tx, task, run.id); // The canonical run/owner/Bot fence, with the run lock.
        const authority: CompletionRecoveryAuthority = { [completionRecoveryAuthority]: true, tx, userId, taskId: task.id, attemptId: task.attemptId, sourceEventId: task.sourceEventId, runId: run.id };
        const current = await completeFactoryExecution(tx, { apply: (owner, currentBinding, id, action, client) => store.apply(owner, currentBinding, id, action, client, authority) }, task, run);
        const start = await dispatch?.(tx, store, current, run);
        const final = await owned(tx, userId, task.id);
        const result = await save(tx, final, eventId, { kind: 'owner_completion_recovery', input: { binding, change }, sourceEventId: task.sourceEventId, attemptId: authority.attemptId, runId: run.id });
        return { result, start };
      });
    },
    /** Owner Retry can recover a legacy missing delivery snapshot from the
     * original clean worktree. It creates no producer and rewrites no history. */
    async retryDeliverableSnapshot(userId: string, rawBinding: FactoryBindingInput, eventId: string, reason: string,
      observe: ObserveRetainedDeliverable, dispatch?: FactoryCompletionDispatch): Promise<{ result: FactorySnapshot; start?: () => Promise<void> } | null> {
      const binding = revisionBindingSchema.parse(rawBinding);
      const change = changeSchema.parse({ action: 'retry', reason });
      uuid(eventId);
      const input = { binding, change };
      const receiptFor = async (tx: PoolClient, task: FactoryTask) => {
        const { rows: [receipt] } = await tx.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, eventId]);
        if (!receipt || receipt.request.kind !== 'owner_deliverable_snapshot_recovery') return null;
        if (!isDeepStrictEqual(receipt.request.input, input)) fail('factoryReplayMismatch');
        if (receipt.request.scope?.sourceEventId !== task.sourceEventId) fail('factoryStale');
        return receipt.result as FactorySnapshot;
      };
      const prepared = await transaction(async tx => {
        const task = await owned(tx, userId, binding.taskId);
        if (terminal(task)) fail('factoryStopped');
        const replayed = await receiptFor(tx, task);
        if (replayed) return { kind: 'replay' as const, result: replayed };
        // Another recovery kind owns this key and handles its own immutable replay.
        if ((await tx.query('SELECT 1 FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, eventId])).rowCount) return null;
        if (task.revision !== binding.revision) fail('factoryStale');
        const eligible = await retainedDeliverableForRecovery(tx, task);
        return eligible ? { kind: 'prepared' as const, ...eligible } : null;
      });
      if (!prepared) return null;
      if (prepared.kind === 'replay') return { result: prepared.result };
      let observed: ObservedRetainedDeliverable | undefined;
      try {
        // The host observer owns its short maintenance lease. No task/run locks
        // are retained while E2B resumes, inspects and re-pauses that same VM.
        observed = await observe(prepared.scope);
        uuid(observed.leaseId);
        if (!snapshotMatchesScope(prepared.scope, observed.snapshot) ||
          Math.abs(Date.now() - Date.parse(observed.snapshot.observedAt)) > 5 * 60_000) fail('factoryDeliverableSnapshotUnavailable');
        const observation = observed;
        return await transaction(async tx => {
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${prepared.scope.workspaceId}`]);
          const task = await owned(tx, userId, binding.taskId);
          if (terminal(task)) fail('factoryStopped');
          const replayed = await receiptFor(tx, task);
          if (replayed) return { result: replayed };
          if (task.revision !== binding.revision) fail('factoryStale');
          await tx.query('SELECT id FROM agent_runs WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[prepared.scope.producerRunId, prepared.scope.machineRunId]]);
          await tx.query('SELECT id FROM factory_questions WHERE id=$1 FOR UPDATE', [prepared.scope.questionId]);
          await tx.query('SELECT "runId" FROM run_checkpoints WHERE "runId"=$1 FOR SHARE', [prepared.scope.producerRunId]);
          await tx.query('SELECT "runId" FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 FOR UPDATE', [prepared.scope.machineRunId, userId]);
          const checked = await retainedDeliverableForRecovery(tx, task, observation.leaseId);
          if (!checked || !isDeepStrictEqual(checked.scope, prepared.scope)) fail('factoryDeliverableSnapshotUnavailable');
          const candidateId = randomUUID();
          const inserted = await tx.query(`INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId","previewDatabaseBranch","machineName",kind)
            SELECT $1,"taskId",sha,repository,environment,scope,"runId","previewDatabaseBranch","machineName",kind
            FROM factory_candidates WHERE id=$2 AND "taskId"=$3 AND kind='deliverable' AND sha IS NULL RETURNING id`,
          [candidateId, task.candidateId, task.id]);
          if (inserted.rowCount !== 1) fail('factoryDeliverableSnapshotUnavailable');
          task.candidateId = candidateId;
          task.reason = reason;
          const next = factoryFlowVersion(task) === 2 && await factoryReviewPerformed(tx, task) ? 'approval' : 'review';
          await freshAttempt(tx, task, next, reason);
          task.revision++;
          await tx.query(`UPDATE factory_tasks SET stage=$6,status='pending',revision=$2,"attemptId"=$3,"candidateId"=$4,reason=$5,"updatedAt"=now() WHERE id=$1`,
          [task.id, task.revision, task.attemptId, candidateId, reason, next]);
          // A changed candidate derives the old check question as superseded.
          // Its row, its failed run, the producer and old receipts stay untouched.
          const request = { kind: 'owner_deliverable_snapshot_recovery', input, scope: checked.scope };
          const snapshotRecovery = { candidateId, snapshot: observation.snapshot };
          const initial = { ...await snapshot(tx, task), snapshotRecovery };
          await tx.query('INSERT INTO factory_events ("taskId","eventId",request,result) VALUES ($1,$2,$3,$4)',
            [task.id, eventId, JSON.stringify(request), JSON.stringify(initial)]);
          // The row lock prevents adoption until COMMIT. Clearing our lease in
          // this transaction lets normal stage admission see a paused source.
          const released = await tx.query(`UPDATE thread_machines SET "workerLeaseId"=NULL,"workerLeaseUntil"=NULL
            WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "sandboxId"=$4 AND "workerLeaseId"=$5 AND "workerLeaseUntil">now() AND state='paused'`,
          [checked.scope.machineRunId, userId, checked.scope.workspaceId, checked.scope.sandboxId, observation.leaseId]);
          if (released.rowCount !== 1) fail('factoryDeliverableSnapshotUnavailable');
          const start = next === 'review' ? await dispatch?.(tx, store, task, checked.review) : undefined;
          const final = await owned(tx, userId, task.id);
          const result = { ...await snapshot(tx, final), snapshotRecovery };
          // Both versions are inside this uncommitted transaction. The one
          // immutable receipt exposed to replays includes the queued review or human handoff.
          await tx.query('UPDATE factory_events SET result=$3 WHERE "taskId"=$1 AND "eventId"=$2', [task.id, eventId, JSON.stringify(result)]);
          await factoryChanged(tx, final);
          return { result, start };
        });
      } finally {
        // The VM is already paused. A transient lease-release error must not
        // suppress the durable handoff after the task transaction committed.
        try { await observed?.release(); }
        catch { console.error(JSON.stringify({ msg: 'factory_deliverable_snapshot_lease_release_failed', taskId: binding.taskId })); }
      }
    },
    /** `anyBot`: every Bot's tasks of the issue (and unscoped ones) in this one read, newest 50 first, as each Bot's store lists them. */
    listForIssue: (userId: string, issueId: string, options: { anyBot?: boolean } = {}) => listIssueTasks(userId, issueId, options.anyBot === true, false),
    /** Coordinator issue context: same batched authorization, with canonical state only for v2 tasks. */
    listPublicForIssue: (userId: string, issueId: string) => listIssueTasks(userId, issueId, false, true),
    /** Hold the task fence before #191 takes its dispatch-key then issue locks. */
    async lockForDispatch(
      userId: string,
      rawBinding: FactoryBinding,
      eventId: string,
      tx: PoolClient,
    ) {
      const parsed = revisionBindingSchema.safeParse(rawBinding);
      if (!parsed.success) fail("factoryInvalid");
      uuid(eventId);
      const binding = parsed.data;
      const task = await owned(tx, userId, binding.taskId);
      if (terminal(task)) fail("factoryStopped");
      const {
        rows: [prior],
      } = await tx.query(
        "SELECT result, request->'change' AS change, (request->'binding'->>'taskId'=$3::jsonb->>'taskId' AND request->'binding'->>'revision'=$3::jsonb->>'revision') AS same FROM factory_events WHERE \"taskId\"=$1 AND \"eventId\"=$2",
        [task.id, eventId, JSON.stringify(binding)],
      );
      if (prior) {
        if (!prior.same || prior.change.action !== "bind_run")
          fail("factoryReplayMismatch");
        const previous = prior.result.task as FactoryTask;
        if (task.revision !== previous.revision || task.attemptId !== previous.attemptId || task.candidateId !== previous.candidateId) fail("factoryStale");
        return previous;
      }
      if (
        task.revision !== binding.revision
      )
        fail("factoryStale");
      if (
        task.status !== "pending" ||
        !["spec", "execute", "review", "verify", "monitor"].includes(task.stage)
      )
        fail("factoryTransition");
      return task;
    },
    /** Internal answer/recover entry: the existing transaction must already
     * contain a verified answer. Client mutations never receive this authority. */
    async retryQuestion(userId: string, rawBinding: FactoryBindingInput, eventId: string, reason: string, questionId: string, tx: PoolClient): Promise<FactorySnapshot> {
      const binding = revisionBindingSchema.parse(rawBinding);
      uuid(questionId);
      const task = await owned(tx, userId, binding.taskId);
      if (task.revision !== binding.revision) fail('factoryStale');
      const runId = await assertQuestionExecutionRetry(tx, task, questionId);
      const authority: QuestionRetryAuthority = { [questionRetryAuthority]: true, tx, userId, taskId: task.id, attemptId: task.attemptId, sourceEventId: task.sourceEventId, runId };
      return store.apply(userId, binding, eventId, { action: 'retry', reason }, tx, undefined, authority);
    },
    /** Trusted backend lifecycle actions require installed consumer gates. */
    async apply(
      userId: string,
      rawBinding: FactoryBindingInput,
      eventId: string,
      rawChange: FactoryChange,
      existingTransaction?: PoolClient,
      completion?: CompletionRecoveryAuthority,
      questionRetry?: QuestionRetryAuthority,
      checkStartRetry?: CheckStartRetryAuthority,
    ) {
      const bp = revisionBindingSchema.safeParse(rawBinding),
        cp = changeSchema.safeParse(rawChange);
      if (!bp.success || !cp.success) fail("factoryInvalid");
      uuid(eventId);
      const binding = bp.data,
        change = cp.data;
      if (JSON.stringify(change).length > 100_000) fail("factoryInvalid");
      return transaction(async (tx) => {
        const task = await owned(tx, userId, binding.taskId);
        if (terminal(task)) fail("factoryStopped");
        const request = { binding, change };
        const previous = await replay(tx, task.id, eventId, request);
        if (previous) {
          if (previous.task.sourceEventId !== task.sourceEventId) fail("factoryStale");
          return previous;
        }
        if (
          task.revision !== binding.revision
        )
          fail("factoryStale");
        const {
          rows: [attempt],
        } = await tx.query<FactoryAttempt>(
          'SELECT * FROM factory_attempts WHERE id=$1 AND "taskId"=$2 FOR UPDATE',
          [task.attemptId, task.id],
        );
        if (!attempt) fail("factoryAttemptMissing");
        const recovering = completion?.[completionRecoveryAuthority] === true && completion.tx === tx && completion.userId === userId &&
          completion.taskId === task.id && completion.attemptId === attempt.id && completion.sourceEventId === task.sourceEventId &&
          completion.runId === attempt.runId && task.stage === 'execute' && attempt.status === 'blocked';
        if (completion && (!recovering || (change.action !== 'candidate' && change.action !== 'advance' && !(change.action === 'finish' && change.status === 'passed')))) fail('factoryTransition');
        const retryingUnfinishedCheck = checkStartRetry?.[checkStartRetryAuthority] === true && checkStartRetry.tx === tx && checkStartRetry.userId === userId &&
          checkStartRetry.taskId === task.id && checkStartRetry.attemptId === attempt.id && checkStartRetry.candidateId === task.candidateId &&
          checkStartRetry.sourceEventId === task.sourceEventId && checkStartRetry.runId === attempt.runId &&
          (checkStartRetry.kind === 'unstarted' || (checkStartRetry.kind === 'unsubmitted' && task.stage === 'review' && factoryFlowVersion(task) === 2)) &&
          ['review', 'verify'].includes(task.stage) && task.status === 'blocked' && attempt.status === 'blocked' && change.action === 'retry';
        if (checkStartRetry && !retryingUnfinishedCheck) fail('factoryCheckBindingMismatch');
        if (!["cancel", "revoke"].includes(change.action) && attempt.output?.requestEpoch != null && attempt.output.requestEpoch !== task.sourceEventId)
          fail("factoryStale");
        if (!["resolve", "cancel", "revoke"].includes(change.action) && !lifecycle)
          fail("factoryTransitionUnavailable");
        if (change.action === "cancel" || change.action === "revoke") {
          task.status = change.action === "cancel" ? "cancelled" : "revoked";
          task.reason = change.reason;
          await tx.query(
            `UPDATE agent_runs SET "stopRequestedAt"=coalesce("stopRequestedAt",now()),"updatedAt"=now()
            WHERE id IN (SELECT "runId" FROM factory_attempts WHERE "taskId"=$1) AND "userId"=$2 AND "issueId"=$3
            AND status IN ('queued','preparing','running','waiting_input','finishing')`,
            [task.id, userId, task.issueId],
          );
          await tx.query(`UPDATE run_tokens SET "revokedAt"=coalesce("revokedAt",now())
            WHERE "userId"=$2 AND "runId" IN (SELECT a."runId" FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" AND r."userId"=$2 AND r."issueId"=$3 WHERE a."taskId"=$1)`,[task.id,userId,task.issueId]);
        } else if (change.action === "resolve") {
          if (task.stage !== "clarify" || task.status !== "waiting")
            fail("factoryTransition");
          const {
            rows: [answer],
          } = await tx.query(
            'SELECT id,payload FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND kind=\'user_message\' AND ("issueId" IS NULL OR "issueId"=$3) AND "createdAt">=(SELECT "createdAt" FROM coordinator_events WHERE id=$4)',
            [change.sourceEventId, userId, task.issueId, task.sourceEventId],
          );
          if (
            !answer ||
            change.sourceEventId === task.sourceEventId ||
            !(await sourceAllowed(
              tx,
              userId,
              change.sourceEventId,
              task.issueId,
            ))
          )
            fail("factorySourceMismatch");
          const stage = routeStage(change);
          task.reason = change.rationale;
          if (stage !== "clarify") {
            await tx.query(
              "UPDATE factory_attempts SET status='passed',reason=$2,output=$3,\"finishedAt\"=clock_timestamp() WHERE id=$1",
              [
                attempt.id,
                change.rationale,
                JSON.stringify({
                  sourceEventId: change.sourceEventId,
                  resolution: change,
                }),
              ],
            );
            await freshAttempt(tx, task, stage, change.rationale);
          } else {
            await tx.query(
              "UPDATE factory_attempts SET output=$2 WHERE id=$1",
              [
                attempt.id,
                JSON.stringify({
                  sourceEventId: change.sourceEventId,
                  unresolved: change,
                }),
              ],
            );
          }
        } else if (change.action === "adopt_retry") {
          if (
            !["spec", "execute", "review", "verify", "monitor"].includes(task.stage) ||
            !attempt.runId ||
            !["running", "failed"].includes(task.status)
          )
            fail("factoryTransition");
          const prior = await runFor(tx, task, attempt.runId);
          const retry = await runFor(tx, task, change.runId);
          const providerRetry = prior.stopReason === "provider_failure" && prior.status === "failed";
          const quotaRetry = prior.stopReason === "quota_exhausted" && ["failed","paused"].includes(prior.status);
          if ((providerRetry || quotaRetry) && await candidateRecheckRound(tx, task)) fail('factoryRunMismatch');
          const expected = quotaRetry && retry.agentDefinition?.apiKey && prior.agentDefinition
            ? apiKeyWorkerDefinition(prior.agentDefinition, retry.prompt, retry.agentDefinition.apiKey)
            : prior.agentDefinition;
          if (
            (!providerRetry && !quotaRetry && (prior.stopReason !== "device_lost" || prior.status !== "failed")) ||
            (task.stage === "monitor" && (!providerRetry || retry.deviceId !== prior.deviceId || retry.deviceRepoId !== prior.deviceRepoId)) ||
            retry.retryOf !== prior.id ||
            (providerRetry ? !(await (await import('../run-provider-fallback')).providerContinuationMatches(prior, retry)) || !(await providerRepositoryRetryMatches(tx, prior, retry))
              : retry.agentId !== prior.agentId && !(await (await import('../run-admission-store')).admittedRepositoryRetryMatches(tx, prior, retry))) ||
            retry.kind !== prior.kind || retry.baseBranch !== prior.baseBranch ||
            (!providerRetry && retry.agentDefinition?.definitionDigest !== expected?.definitionDigest)
          )
            fail("factoryRunMismatch");
          await tx.query(
            'UPDATE factory_attempts SET status=\'failed\',reason=$2,"sessionId"=$3,output=output || $4::jsonb,"finishedAt"=clock_timestamp() WHERE id=$1',
            [
              attempt.id,
              String(prior.error ?? (providerRetry ? "Model provider failed" : "Device lost")).slice(0, 4000),
              prior.sessionId,
              JSON.stringify(providerRetry ? { recovery: "provider_failure" } : {}),
            ],
          );
          task.reason = change.reason;
          if (task.stage === "execute") task.candidateId = null;
          await freshAttempt(tx, task, task.stage, change.reason);
          await tx.query(
            'UPDATE factory_attempts SET status=\'running\',"runId"=$2,"sessionId"=$3 WHERE id=$1',
            [task.attemptId, retry.id, retry.sessionId],
          );
          if (["review","verify"].includes(task.stage) || (providerRetry && task.stage === "monitor")) {
            // Checks restart independently on the same candidate; they never
            // resume the failed/paused CLI session or acquire its observations.
            const monitor = attempt.output.monitorDispatch;
            if (providerRetry && task.stage === "monitor" && (!monitor || typeof monitor !== "object" || Array.isArray(monitor) ||
              (monitor as Record<string, unknown>).deviceRepoId !== prior.deviceRepoId)) fail("factoryRunMismatch");
            await tx.query(`UPDATE agent_runs SET "retryOf"=NULL,"sessionId"=NULL,prompt=$2,"agentDefinition"=jsonb_set("agentDefinition",'{promptDigest}',to_jsonb($3::text)) WHERE id=$1`, [retry.id, prior.prompt, (await import('../agent-kit/worker')).retryWorkerDefinition(retry.agentDefinition, prior.prompt)!.promptDigest]);
            const check = attempt.output.check;
            if (providerRetry && task.stage !== "monitor" && (!check || typeof check !== "object" || Array.isArray(check))) fail("factoryRunMismatch");
            const assignment = task.stage === "monitor" ? { monitorDispatch: monitor }
              : { check: providerRetry ? { ...(check as Record<string, unknown>), deviceRepoId: retry.deviceRepoId, environment: `device:${retry.deviceId}`,
                ...(retry.agentDefinition?.policyCeiling ? { policy: intersectRunPolicy(runPolicySchema.parse((check as Record<string, unknown>).policy), retry.agentDefinition.policyCeiling) } : {}) } : check };
            await tx.query('UPDATE factory_attempts SET "sessionId"=NULL,output=output || $2::jsonb WHERE id=$1', [task.attemptId, JSON.stringify(assignment)]);
            await tx.query('INSERT INTO factory_events ("taskId","eventId",request,result) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [task.id, (await import('./event-id')).factoryEventId(providerRetry ? 'provider-check-continuation' : 'quota-check-continuation',prior.id), JSON.stringify({ priorRunId: prior.id }), JSON.stringify({ runId: retry.id })]);
          }
          task.status = "running";
        } else if (change.action === "bind_run") {
          if (task.status !== "pending" || attempt.runId)
            fail("factoryTransition");
          const run = await runFor(tx, task, change.runId);
          const expectedKind = task.stage === "spec" ? "plan" : task.stage === "execute" ? "implement" : ["review", "verify", "monitor"].includes(task.stage) ? "acceptance" : null;
          if (!expectedKind || run.kind !== expectedKind) fail("factoryRunMismatch");
          if (
            ![
              "queued",
              "preparing",
              "running",
              "waiting_input",
              "finishing",
            ].includes(run.status)
          )
            fail("factoryRunMismatch");
          if (["review", "verify"].includes(task.stage)) {
            const { rows } = await tx.query(
              'SELECT 1 FROM factory_attempts WHERE "taskId"=$1 AND "runId"=$2',
              [task.id, run.id],
            );
            if (rows.length) fail("factoryIndependentRunRequired");
          }
          await tx.query(
            'UPDATE factory_attempts SET "runId"=$2,"sessionId"=$3 WHERE id=$1',
            [attempt.id, run.id, run.sessionId],
          );
          if (["review", "verify", "monitor"].includes(task.stage)) {
            // Binding changes this run's role, not the Task executor's role.
            // Its durable fence is SQL-atomic; push close only after commits.
            await (await import('../coding-workspace/review-sessions')).reviewRunBecameChecker(tx, run.id);
          }
          task.status = "running";
        } else if (change.action === "candidate") {
          if (
            task.stage !== "execute" ||
            task.candidateId !== null || attempt.candidateId !== null ||
            (task.status !== "running" && !(recovering && task.status === 'blocked')) ||
            attempt.runId !== change.runId
          )
            fail("factoryTransition");
          const producingRun = await runFor(tx, task, change.runId);
          const machine = (await tx.query('SELECT name FROM devices WHERE id=$1 AND "ownerId"=$2', [producingRun.deviceId, task.userId])).rows[0];
          const branch = typeof producingRun.report?.previewDatabaseBranch === "string" ? producingRun.report.previewDatabaseBranch.trim().slice(0, 500) || null : null;
          const candidate = factoryCandidateSchema.parse(change.candidate),
            candidateId = randomUUID();
          await tx.query(
            'INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId","previewDatabaseBranch","machineName",kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [
              candidateId,
              task.id,
              candidate.sha,
              candidate.repository,
              candidate.environment,
              candidate.scope,
              change.runId,
              branch,
              machine?.name ?? null,
              'kind' in candidate ? candidate.kind : 'repository',
            ],
          );
          task.candidateId = candidateId;
          if (!recovering) await tx.query(
            'UPDATE factory_attempts SET "candidateId"=$2 WHERE id=$1',
            [attempt.id, candidateId],
          );
        } else if (change.action === "finish") {
          if (!["pending", "running", "waiting"].includes(task.status) && !(recovering && task.status === 'blocked'))
            fail("factoryTransition");
          if (attempt.runId) {
            const {
              rows: [provenance],
            } = await tx.query(
              'SELECT "sessionId" FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3',
              [attempt.runId, userId, task.issueId],
            );
            if (!provenance && change.status !== "blocked")
              fail("factoryRunMismatch");
            if (provenance) {
              if (!recovering) await tx.query(
                'UPDATE factory_attempts SET "sessionId"=$2 WHERE id=$1',
                [attempt.id, provenance.sessionId],
              );
              attempt.sessionId = provenance.sessionId;
            }
          }
          if (["review", "verify", "monitor"].includes(task.stage) &&
              ["passed", "failed"].includes(change.status)) {
            if (!attempt.runId || !lifecycle?.independent ||
                !(await lifecycle.independent(tx, task, attempt.runId)))
              fail("factoryIndependentRunRequired");
          }
          if (change.status === "passed") {
            const consumerStage = [
              "review",
              "verify",
              "approval",
              "publish",
              "monitor",
            ].includes(task.stage);
            if (consumerStage) {
              const gate = lifecycle?.gates?.[task.stage as keyof FactoryGates];
              if (!gate || !(await gate(tx, task, attempt, change)))
                fail("factoryConsumerGateRequired");
            }
            if (
              (!task.candidateId && task.stage !== "spec") ||
              !change.evidence.length
            )
              fail("factoryEvidenceRequired");
            const {
              rows: [candidate],
            } = await tx.query(
              'SELECT * FROM factory_candidates WHERE id=$1 AND "taskId"=$2',
              [task.candidateId, task.id],
            );
            for (const evidence of change.evidence) {
              if (
                evidence.candidateId !== task.candidateId ||
                evidence.sha !== (candidate?.sha ?? null) ||
                (candidate && evidence.environment !== candidate.environment)
              )
                fail("factoryEvidenceMismatch");
            }
            if (["approval", "publish", "monitor"].includes(task.stage)) {
              // These consumers verify human identity, artifacts and exact target/action
              // inside their gate on this locked transaction. They need not own a run.
            } else {
              if (!attempt.runId) fail("factoryEvidenceRequired");
              const run = await runFor(tx, task, attempt.runId);
              if (run.status !== "succeeded" || !run.sessionId)
                fail("factoryEvidenceRequired");
              if (
                task.stage === "execute" &&
                (run.stopReason !== 'submitted' ||
                  (candidate?.kind === 'report'
                    ? run.report?.sourceCommit !== candidate.sha
                    : candidate?.kind === 'deliverable'
                      ? candidate.sha !== null || !/^[a-f0-9]{40}$/.test(run.report?.sourceCommit ?? '')
                      : !repositoryExecutionMatches(run.report,candidate?.sha)))
              )
                fail("factoryEvidenceMismatch");
              for (const evidence of change.evidence) {
                if (
                  evidence.runId !== run.id ||
                  evidence.sessionId !== run.sessionId
                )
                  fail("factoryEvidenceMismatch");
                if (
                  evidence.kind === "report" &&
                  evidence.artifact === `run-report:${run.id}` &&
                  run.report
                )
                  continue;
                const captureId = captureIdOf(evidence.artifact);
                if (captureId && (evidence.kind === "screenshot" || evidence.kind === "video")) {
                  // The run's own ready capture of the stated kind; no other run's file.
                  const { rows } = await tx.query(
                    `SELECT id FROM run_captures WHERE id=$1 AND "runId"=$2 AND "userId"=$3 AND status='ready' AND kind=$4`,
                    [captureId, run.id, task.userId, evidence.kind === "video" ? "video" : "image"],
                  );
                  if (!rows.length) fail("factoryArtifactMissing");
                  continue;
                }
                if (
                  evidence.kind !== "log" ||
                  !evidence.artifact.startsWith("run-chunk:")
                )
                  fail("factoryArtifactMissing");
                const chunkId = evidence.artifact.slice("run-chunk:".length);
                uuid(chunkId);
                const { rows } = await tx.query(
                  'SELECT id FROM run_chunks WHERE id=$1 AND "runId"=$2',
                  [chunkId, run.id],
                );
                if (!rows.length) fail("factoryArtifactMissing");
              }
              if (!recovering) await tx.query(
                'UPDATE factory_attempts SET "sessionId"=$2 WHERE id=$1',
                [attempt.id, run.sessionId],
              );
            }
          }
          task.status = change.status;
          task.reason = change.reason;
          if (!recovering) await tx.query(
            "UPDATE factory_attempts SET output=$2,evidence=$3 WHERE id=$1",
            [
              attempt.id,
              JSON.stringify({ ...attempt.output, ...change.output }),
              JSON.stringify(change.evidence),
            ],
          );
        } else if (change.action === "advance") {
          if (
            task.status !== "passed" ||
            change.stage !== await factoryNextStage(tx, task)
          )
            fail("factoryTransition");
          if (task.stage === 'spec' && factoryFlowVersion(task) === 2) {
            const approved = await tx.query('SELECT 1 FROM factory_spec_approvals WHERE "taskId"=$1 AND "attemptId"=$2 AND "sourceEventId"=$3 AND "userId"=$4',
              [task.id, task.attemptId, task.sourceEventId, task.userId]);
            if (!approved.rowCount) fail('factory_spec_approval_required');
          }
          task.reason = change.reason;
          await freshAttempt(tx, task, change.stage, change.reason);
        } else if (change.action === "retry_publication") {
          if (task.stage !== 'publish' || task.status !== 'pending' || !task.candidateId)
            fail('factoryTransition');
          const { rowCount } = await tx.query(`SELECT id FROM factory_publications WHERE id=$1 AND "taskId"=$2 AND "candidateId"=$3 AND status='failed' AND request->'binding'->>'revision'=$4 FOR UPDATE`, [change.publicationId, task.id, task.candidateId, String(task.revision)]);
          if (rowCount !== 1) fail('factoryPublicationReceiptRequired');
          await tx.query(`UPDATE factory_attempts SET status='failed',reason=$2,"finishedAt"=clock_timestamp() WHERE id=$1`, [attempt.id, change.reason]);
          task.reason = change.reason;
          await freshAttempt(tx, task, 'approval', change.reason);
        } else if (change.action === "retry" || change.action === "repair") {
          if (task.stage === "clarify") fail("factoryTransition");
          // A completed review can lead to repair or human judgment, never a
          // second review of this task. Its authenticated question continuation,
          // or a host-qualified Owner retry without any submitted result, only
          // completes that one review and keeps its exact custody checks.
          if (change.action === 'retry' && task.stage === 'review' && factoryFlowVersion(task) === 2 &&
              !questionRetry && !retryingUnfinishedCheck && await factoryReviewPerformed(tx, task)) fail('factoryTransition');
          const pendingQuestion = await tx.query(
            "SELECT id FROM factory_questions WHERE \"taskId\"=$1 AND \"attemptId\"=$2 AND status IN ('open','waiting_user') LIMIT 1",
            [task.id, attempt.id],
          );
          if (pendingQuestion.rows.length) fail("factoryQuestionPending");
          // A failed strict question can only continue through owner recovery,
          // which validates custody and transitions the question in this transaction.
          const strictQuestion = await tx.query(`SELECT 1 FROM factory_questions q
            JOIN agent_runs r ON r.id=q."continuationRunId" AND r."userId"=q."userId"
            WHERE q."taskId"=$1 AND q.status='blocked' AND q."continuationRunId"=$2
              AND r."questionContinuation"->>'requireSessionResume'='true' LIMIT 1`, [task.id,attempt.runId]);
          if (strictQuestion.rowCount) fail("factoryQuestionContinuationUnavailable");
          // A completed monitor observation can open another observation of the
          // same candidate. freshAttempt retains the candidate, never run evidence.
          const nextMonitorCycle =
            change.action === "retry" &&
            task.stage === "monitor" &&
            task.status === "passed" &&
            task.candidateId !== null &&
            attempt.stage === "monitor" &&
            attempt.status === "passed" &&
            attempt.candidateId === task.candidateId;
          const requestedRepair = change.action === 'repair' && task.status === 'pending' && ['review', 'verify', 'approval'].includes(task.stage);
          if (
            !nextMonitorCycle &&
            !requestedRepair &&
            !["failed", "blocked", "waiting"].includes(task.status)
          )
            fail("factoryTransition");
          if (
            change.action === "repair" &&
            !["review", "verify", "approval", "monitor"].includes(task.stage)
          )
            fail("factoryTransition");
          // A live old run must stop before another attempt can bind work.
          if (attempt.runId) {
            const {
              rows: [run],
            } = await tx.query(
              "SELECT status FROM agent_runs WHERE id=$1 FOR UPDATE",
              [attempt.runId],
            );
            if (
              run &&
              !["succeeded", "completed", "failed", "stopped", "cancelled"].includes(
                run.status,
              )
            )
              fail("factoryRunStillActive");
          }
          const continuingQuestion = questionRetry?.[questionRetryAuthority] === true && questionRetry.tx === tx &&
            questionRetry.userId === userId && questionRetry.taskId === task.id && questionRetry.attemptId === attempt.id &&
            questionRetry.sourceEventId === task.sourceEventId && questionRetry.runId === attempt.runId && change.action === 'retry';
          if (questionRetry && !continuingQuestion) fail('factoryQuestionContinuationUnavailable');
          // Every new repair execution, including Owner HTTP and generic retry,
          // shares this locked cap. A validated question continuation is one
          // execution and cannot be requested by the public change schema.
          if ((change.action === 'repair' || task.stage === 'execute') && !continuingQuestion)
            await checkFactoryRepairBudget(tx, task);
          task.reason = change.reason;
          if (change.action === "repair") task.candidateId = null;
          await freshAttempt(
            tx,
            task,
            change.action === "repair" ? "execute" : task.stage,
            change.reason,
          );
        }
        else fail("factoryTransitionUnavailable");
        const stoppedFinishedAttempt =
          (change.action === "cancel" || change.action === "revoke") &&
          ["passed", "failed", "blocked"].includes(attempt.status);
        if (task.attemptId === attempt.id && !stoppedFinishedAttempt && !recovering) {
          await tx.query(
            "UPDATE factory_attempts SET status=$2,reason=$3,\"finishedAt\"=CASE WHEN $2 IN ('passed','failed','blocked','cancelled','revoked') THEN clock_timestamp() ELSE NULL END WHERE id=$1",
            [attempt.id, task.status, task.reason],
          );
        }
        task.revision++;
        await tx.query(
          'UPDATE factory_tasks SET stage=$2,status=$3,revision=$4,"attemptId"=$5,"candidateId"=$6,reason=$7,"updatedAt"=now() WHERE id=$1',
          [
            task.id,
            task.stage,
            task.status,
            task.revision,
            task.attemptId,
            task.candidateId,
            task.reason,
          ],
        );
        return save(tx, task, eventId, request);
      }, existingTransaction);
    },
  };
  return store;
}
