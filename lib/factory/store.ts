import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  bindingSchema,
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
  sourceEventId: string;
  route: z.infer<typeof routeSchema>;
  stage: FactoryStage;
  status: FactoryStatus;
  revision: number;
  attemptId: string;
  candidateId: string | null;
  reason: string;
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
  botId: string | null = null,
) {
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
    if (
      !task ||
      task.botId !== botId ||
      !(await authorize(userId, task.issueId, tx)) ||
      !(await sourceAllowed(tx, userId, task.sourceEventId, task.issueId))
    )
      fail("factoryNotFound");
    return task;
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
    async route(userId: string, input: unknown) {
      const parsed = routeSchema.safeParse(input);
      if (!parsed.success) fail("factoryInvalid");
      const route = parsed.data;
      return transaction(async (tx) => {
        if (!(await authorize(userId, route.issueId, tx)))
          fail("factoryNotFound");
        // Owner/issue lock serializes competing routes before a task row exists.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          JSON.stringify([userId, route.issueId]),
        ]);
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
        const {
          rows: [prior],
        } = await tx.query<FactoryTask>(
          'SELECT * FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2 AND "sourceEventId"=$3 FOR UPDATE',
          [userId, route.issueId, route.sourceEventId],
        );
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
          `INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId",route,stage,status,revision,"attemptId",reason,"botId") VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10)`,
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
        if (!(await authorize(userId, issueId, tx))) fail("factoryNotFound");
        const { rows } = await tx.query<FactoryTask>(
          'SELECT * FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2 AND "botId" IS NOT DISTINCT FROM $3::uuid ORDER BY "updatedAt" DESC,id DESC LIMIT 50',
          [userId, issueId, botId],
        );
        const tasks = [];
        for (const row of rows)
          if (await sourceAllowed(tx, userId, row.sourceEventId, issueId))
            tasks.push(row);
        return { contractVersion: 1 as const, issueId, tasks };
      });
    },
    /** Intake only: consumer lifecycle actions remain unavailable in this extraction. */
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
        if (change.action === "cancel" || change.action === "revoke") {
          task.status = change.action === "cancel" ? "cancelled" : "revoked";
          task.reason = change.reason;
          await tx.query(
            `UPDATE agent_runs SET "stopRequestedAt"=coalesce("stopRequestedAt",now()),"updatedAt"=now()
            WHERE id IN (SELECT "runId" FROM factory_attempts WHERE "taskId"=$1) AND "userId"=$2 AND "issueId"=$3
            AND status IN ('queued','preparing','running','waiting_input','finishing')`,
            [task.id, userId, task.issueId],
          );
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
              "UPDATE factory_attempts SET status='passed',reason=$2,output=$3,\"finishedAt\"=now() WHERE id=$1",
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
        } else fail("factoryTransitionUnavailable");
        const stoppedFinishedAttempt =
          (change.action === "cancel" || change.action === "revoke") &&
          ["passed", "failed", "blocked"].includes(attempt.status);
        if (task.attemptId === attempt.id && !stoppedFinishedAttempt) {
          await tx.query(
            "UPDATE factory_attempts SET status=$2,reason=$3,\"finishedAt\"=CASE WHEN $2 IN ('passed','failed','blocked','cancelled','revoked') THEN now() ELSE NULL END WHERE id=$1",
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
