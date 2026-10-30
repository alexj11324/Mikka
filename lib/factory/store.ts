import { randomUUID } from "node:crypto";
import { factoryCheckIndependent } from "./check-independence";
import { factoryScopeAllows, type FactoryIssueScope } from "./scope";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  bindingSchema,
  candidateSchema,
  nextStage,
  changeSchema,
  FactoryError,
  routeSchema,
  routeStage,
  type FactoryBinding,
  type FactoryChange,
  type FactoryStage,
  type FactoryStatus,
} from "./contract";

export interface FactoryTask {
  id: string;
  userId: string;
  botId: string | null;
  issueId: string;
  scopeVersion: number | null;
  sourceEventId: string;
  route: z.infer<typeof routeSchema>;
  stage: FactoryStage;
  status: FactoryStatus;
  revision: number;
  attemptId: string;
  candidateId: string | null;
  reason: string;
}
export type FactoryTaskSummary = Pick<FactoryTask, "id" | "issueId" | "stage" | "status" | "revision" | "attemptId" | "candidateId" | "reason"> & {
  isSkillCandidate: boolean;
  /** The run that produced the candidate, so acceptance can sit beside its thread. */
  candidateRunId: string | null;
  /** Commit of the current candidate, so a card can tell a stale approval apart without the ledger. */
  candidateSha: string | null;
  /** Latest publication for the current candidate, if any. */
  publication: FactoryPublicationSummary | null;
};
export interface FactoryPublicationSummary {
  id: string;
  status: string;
  action: string;
  target: string;
  createdAt: string;
  finishedAt: string | null;
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
  sha: string;
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
export type FactoryAuthorize = (
  userId: string,
  issueId: string,
  tx: PoolClient,
) => Promise<boolean>;
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
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const result = await fn(tx);
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  }
  async function sourceAllowed(
    tx: PoolClient,
    userId: string,
    eventId: string,
    issueId: string,
  ) {
    const { rows } = await tx.query(
      `SELECT e.id FROM coordinator_events e WHERE e.id=$1 AND e."userId"=$2 AND e.kind='user_message' AND e."botId" IS NOT DISTINCT FROM $3::uuid AND (e."issueId" IS NULL OR e."issueId"=$4) AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM bots b WHERE b.id=$3 AND b."ownerId"=$2))`,
      [eventId, userId, botId, issueId],
    );
    return rows.length === 1;
  }
  async function owned(tx: PoolClient, userId: string, taskId: string) {
    uuid(taskId);
    const {
      rows: [task],
    } = await tx.query<FactoryTask>(
      'SELECT * FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR UPDATE',
      [taskId, userId],
    );
    const issue = task ? await lockedIssue(tx, task.issueId) : undefined;
    if (
      !task ||
      task.botId !== botId ||
      !factoryScopeAllows(task, issue) ||
      !(await authorize(userId, task.issueId, tx)) ||
      !(await sourceAllowed(tx, userId, task.sourceEventId, task.issueId))
    )
      fail("factoryNotFound");
    return task;
  }
  async function lockedIssue(tx: PoolClient, issueId: string) {
    const { rows: [issue] } = await tx.query<FactoryIssueScope>('SELECT "userId",scope,"scopeVersion" FROM issues WHERE id=$1 FOR SHARE', [issueId]);
    return issue;
  }
  async function snapshot(
    tx: PoolClient,
    task: FactoryTask,
  ): Promise<FactorySnapshot> {
    const { rows: attempts } = await tx.query<FactoryAttempt>(
      'SELECT * FROM factory_attempts WHERE "taskId"=$1 ORDER BY position',
      [task.id],
    );
    const { rows: candidates } = await tx.query<FactoryCandidate>(
      'SELECT * FROM factory_candidates WHERE "taskId"=$1 ORDER BY "createdAt"',
      [task.id],
    );
    // Return the same JSON representation on the first call and durable replay.
    return JSON.parse(
      JSON.stringify({ contractVersion: 1, task, attempts, candidates }),
    ) as FactorySnapshot;
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
      'SELECT result, request=$3::jsonb AS same FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2',
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
    return result;
  }
  async function runFor(tx: PoolClient, task: FactoryTask, runId: string) {
    const {
      rows: [run],
    } = await tx.query(
      'SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR UPDATE',
      [runId, task.userId, task.issueId],
    );
    if (!run || run.stopRequestedAt || run.botId !== task.botId) fail("factoryRunMismatch");
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
      `INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"candidateId",reason)
      SELECT $1,$2,$3,coalesce(max(ordinal) FILTER (WHERE stage=$3),0)+1,coalesce(max(position),0)+1,'pending',$4,$5 FROM factory_attempts WHERE "taskId"=$2`,
      [id, task.id, stage, task.candidateId, reason],
    );
    task.attemptId = id;
    task.stage = stage;
    task.status = "pending";
  }
  return {
    lockTask: owned,
    async route(userId: string, input: unknown) {
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
          'SELECT * FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2 AND "sourceEventId"=$3 FOR UPDATE',
          [userId, route.issueId, route.sourceEventId],
        );
        const issue = await lockedIssue(tx, route.issueId);
        if (!issue || !(await authorize(userId, route.issueId, tx))) fail("factoryNotFound");
        if (prior && !factoryScopeAllows(prior, issue)) fail("factoryNotFound");
        const {
          rows: [source],
        } = await tx.query(
          'SELECT id FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND kind=\'user_message\' AND ("issueId" IS NULL OR "issueId"=$3)',
          [route.sourceEventId, userId, route.issueId],
        );
        if (
          !source ||
          !(await sourceAllowed(tx, userId, route.sourceEventId, route.issueId))
        )
          fail("factorySourceMismatch");
        if (prior) {
          if (prior.botId !== botId) fail("factoryNotFound");
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
          scopeVersion: issue.scopeVersion,
          sourceEventId: route.sourceEventId,
          route,
          stage: routeStage(route),
          status: routeStage(route) === "clarify" ? "waiting" : "pending",
          revision: 1,
          attemptId: randomUUID(),
          candidateId: null,
          reason: route.rationale,
        };
        await tx.query(
          `INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId",route,stage,status,revision,"attemptId",reason,"botId","scopeVersion") VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11)`,
          [
            task.id,
            userId,
            task.issueId,
            task.sourceEventId,
            JSON.stringify(route),
            task.stage,
            task.status,
            task.attemptId,
            task.reason,
            botId,
            task.scopeVersion,
          ],
        );
        await tx.query(
          'INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,reason) VALUES ($1,$2,$3,1,1,$4,$5)',
          [task.attemptId, task.id, task.stage, task.status, task.reason],
        );
        return save(tx, task, route.eventId, route);
      });
    },
    async read(userId: string, taskId: string) {
      return transaction(async (tx) =>
        snapshot(tx, await owned(tx, userId, taskId)),
      );
    },
    async listForIssue(userId: string, issueId: string) {
      uuid(issueId);
      return transaction(async (tx) => {
        const issue = await lockedIssue(tx, issueId);
        if (!issue || !(await authorize(userId, issueId, tx))) fail("factoryNotFound");
        const { rows } = await tx.query<FactoryTask & { isSkillCandidate: boolean; candidateRunId: string | null; candidateSha: string | null; publication: FactoryPublicationSummary | null }>(
          'SELECT t.*, c."runId" AS "candidateRunId", c.sha AS "candidateSha", (SELECT json_build_object(\'id\',p.id,\'status\',p.status,\'action\',p.action,\'target\',p.target,\'createdAt\',p."createdAt",\'finishedAt\',p."finishedAt") FROM factory_publications p WHERE p."taskId"=t.id AND p."candidateId"=t."candidateId" ORDER BY p."createdAt" DESC,p.id DESC LIMIT 1) AS publication, EXISTS (SELECT 1 FROM improvement_skill_candidates s WHERE s."factoryTaskId"=t.id AND s."candidateId"=t."candidateId" AND s."userId"=t."userId") AS "isSkillCandidate" FROM factory_tasks t JOIN issues i ON i.id=t."issueId" LEFT JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id WHERE t."userId"=$1 AND t."issueId"=$2 AND t."botId" IS NOT DISTINCT FROM $3::uuid AND (i."userId"=$1 OR (i.scope=\'workspace\' AND t."scopeVersion"=i."scopeVersion")) ORDER BY t."updatedAt" DESC,t.id DESC LIMIT 50',
          [userId, issueId, botId],
        );
        const tasks: FactoryTaskSummary[] = [];
        for (const row of rows)
          if (factoryScopeAllows(row, issue) && await sourceAllowed(tx, userId, row.sourceEventId, issueId)) {
            const { id, issueId, stage, status, revision, attemptId, candidateId, reason, isSkillCandidate, candidateRunId, candidateSha, publication } = row;
            tasks.push({id,issueId,stage,status,revision,attemptId,candidateId,reason,isSkillCandidate,candidateRunId,candidateSha:candidateSha ?? null,publication:publication ?? null});
          }
        return { contractVersion: 1 as const, issueId, tasks };
      });
    },
    /** Hold the task fence before #191 takes its dispatch-key then issue locks. */
    async lockForDispatch(
      userId: string,
      rawBinding: FactoryBinding,
      eventId: string,
      tx: PoolClient,
    ) {
      const parsed = bindingSchema.safeParse(rawBinding);
      if (!parsed.success) fail("factoryInvalid");
      uuid(eventId);
      const binding = parsed.data;
      const task = await owned(tx, userId, binding.taskId);
      if (task.issueId !== binding.issueId) fail("factoryNotFound");
      if (terminal(task)) fail("factoryStopped");
      const {
        rows: [prior],
      } = await tx.query(
        "SELECT result, request->'change' AS change, request->'binding'=$3::jsonb AS same FROM factory_events WHERE \"taskId\"=$1 AND \"eventId\"=$2",
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
        task.revision !== binding.revision ||
        task.attemptId !== binding.attemptId ||
        task.candidateId !== binding.candidateId
      )
        fail("factoryStale");
      if (
        task.status !== "pending" ||
        !["spec", "execute", "review", "verify", "monitor"].includes(task.stage)
      )
        fail("factoryTransition");
      return task;
    },
    /** Trusted backend lifecycle actions require installed consumer gates. */
    async apply(
      userId: string,
      rawBinding: FactoryBinding,
      eventId: string,
      rawChange: FactoryChange,
      existingTransaction?: PoolClient,
    ) {
      const bp = bindingSchema.safeParse(rawBinding),
        cp = changeSchema.safeParse(rawChange);
      if (!bp.success || !cp.success) fail("factoryInvalid");
      uuid(eventId);
      const binding = bp.data,
        change = cp.data;
      if (JSON.stringify(change).length > 100_000) fail("factoryInvalid");
      return transaction(async (tx) => {
        const task = await owned(tx, userId, binding.taskId);
        if (task.issueId !== binding.issueId) fail("factoryNotFound");
        if (terminal(task)) fail("factoryStopped");
        const request = { binding, change };
        const previous = await replay(tx, task.id, eventId, request);
        if (previous) return previous;
        if (
          task.revision !== binding.revision ||
          task.attemptId !== binding.attemptId ||
          task.candidateId !== binding.candidateId
        )
          fail("factoryStale");
        const {
          rows: [attempt],
        } = await tx.query<FactoryAttempt>(
          'SELECT * FROM factory_attempts WHERE id=$1 AND "taskId"=$2 FOR UPDATE',
          [task.attemptId, task.id],
        );
        if (!attempt) fail("factoryAttemptMissing");
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
            'SELECT id FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND kind=\'user_message\' AND ("issueId" IS NULL OR "issueId"=$3) AND "createdAt">=(SELECT "createdAt" FROM coordinator_events WHERE id=$4)',
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
            !["spec", "execute"].includes(task.stage) ||
            !attempt.runId ||
            !["running", "failed"].includes(task.status)
          )
            fail("factoryTransition");
          const prior = await runFor(tx, task, attempt.runId);
          const retry = await runFor(tx, task, change.runId);
          if (
            prior.stopReason !== "device_lost" ||
            prior.status !== "failed" ||
            retry.retryOf !== prior.id || retry.agentId !== prior.agentId ||
            retry.kind !== prior.kind || retry.baseBranch !== prior.baseBranch ||
            retry.agentDefinition?.definitionDigest !== prior.agentDefinition?.definitionDigest
          )
            fail("factoryRunMismatch");
          await tx.query(
            'UPDATE factory_attempts SET status=\'failed\',reason=$2,"sessionId"=$3,"finishedAt"=clock_timestamp() WHERE id=$1',
            [
              attempt.id,
              String(prior.error ?? "Device lost").slice(0, 4000),
              prior.sessionId,
            ],
          );
          task.reason = change.reason;
          if (task.stage === "execute") task.candidateId = null;
          await freshAttempt(tx, task, task.stage, change.reason);
          await tx.query(
            'UPDATE factory_attempts SET status=\'running\',"runId"=$2,"sessionId"=$3 WHERE id=$1',
            [task.attemptId, retry.id, retry.sessionId],
          );
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
          task.status = "running";
        } else if (change.action === "candidate") {
          if (
            task.stage !== "execute" ||
            task.candidateId !== null || attempt.candidateId !== null ||
            task.status !== "running" ||
            attempt.runId !== change.runId
          )
            fail("factoryTransition");
          await runFor(tx, task, change.runId);
          const candidate = candidateSchema.parse(change.candidate),
            candidateId = randomUUID();
          await tx.query(
            'INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId") VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [
              candidateId,
              task.id,
              candidate.sha,
              candidate.repository,
              candidate.environment,
              candidate.scope,
              change.runId,
            ],
          );
          task.candidateId = candidateId;
          await tx.query(
            'UPDATE factory_attempts SET "candidateId"=$2 WHERE id=$1',
            [attempt.id, candidateId],
          );
        } else if (change.action === "finish") {
          if (!["pending", "running", "waiting"].includes(task.status))
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
              await tx.query(
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
                (run.report?.publish?.commit !== candidate?.sha ||
                  run.stopReason !== "submitted" ||
                  run.report?.verify?.status !== "passed")
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
              await tx.query(
                'UPDATE factory_attempts SET "sessionId"=$2 WHERE id=$1',
                [attempt.id, run.sessionId],
              );
            }
          }
          task.status = change.status;
          task.reason = change.reason;
          await tx.query(
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
            change.stage !== nextStage(task.stage)
          )
            fail("factoryTransition");
          task.reason = change.reason;
          await freshAttempt(tx, task, change.stage, change.reason);
        } else if (change.action === "retry" || change.action === "repair") {
          if (task.stage === "clarify") fail("factoryTransition");
          const pendingQuestion = await tx.query(
            "SELECT id FROM factory_questions WHERE \"taskId\"=$1 AND \"attemptId\"=$2 AND status IN ('open','waiting_user') LIMIT 1",
            [task.id, attempt.id],
          );
          if (pendingQuestion.rows.length) fail("factoryQuestionPending");
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
          if (
            !nextMonitorCycle &&
            !["failed", "blocked", "waiting"].includes(task.status)
          )
            fail("factoryTransition");
          if (
            change.action === "repair" &&
            !["review", "verify", "monitor"].includes(task.stage)
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
              !["succeeded", "failed", "stopped", "cancelled"].includes(
                run.status,
              )
            )
              fail("factoryRunStillActive");
          }
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
        if (task.attemptId === attempt.id && !stoppedFinishedAttempt) {
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
}
