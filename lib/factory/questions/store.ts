import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { DEVICE_ONLINE_WINDOW_MS } from "@mikka/protocol/device";
import { FactoryError, type FactoryBinding } from "../contract";
import { factoryEventId } from "../event-id";
import type {
  createFactoryStore,
  FactoryAuthorize,
  FactoryTask,
} from "../store";
import type { FactoryDispatchInput } from "../dispatch";
import { factoryCheckAssignment } from "../checks";
import { tiptapToText } from "../../tiptap-text";
import {
  contextQuestionAnswerSchema,
  humanQuestionAnswerSchema,
  questionEscalationSchema,
  questionHandoffSchema,
  legacyQuestionId,
  orchestratorMayAnswer,
  questionFingerprint,
  type QuestionHandoff,
  type QuestionKind,
  type QuestionStatus,
  type QuestionReference,
} from "./contract";

export interface FactoryQuestion {
  id: string;
  userId: string;
  issueId: string;
  taskId: string;
  attemptId: string;
  candidateId: string | null;
  stage: string;
  originRunId: string;
  originSessionId: string;
  originRevision: number;
  waitingBinding: FactoryBinding;
  kind: QuestionKind;
  question: string;
  context: string;
  options: string[];
  status: QuestionStatus;
  revision: number;
  reason: string;
  sourceEventId: string;
  request: unknown;
  expiresAt: Date | null;
  escalationEventId: string | null;
  escalationRequest: unknown;
  answerId: string | null;
  answerSource: string | null;
  answerFingerprint: string | null;
  answer: unknown;
  result: QuestionContinuation | null;
  continuationRunId: string | null;
  createdAt: Date;
}
export interface QuestionContinuation {
  questionId: string;
  continuationRunId: string;
  task: FactoryTask;
  replayed: boolean;
}
export type QuestionActor =
  | { source: "human"; userId: string; sessionId: string }
  | { source: "human_event"; userId: string }
  | { source: "orchestrator"; userId: string };
type Dispatch = (
  userId: string,
  input: FactoryDispatchInput,
  tx?: PoolClient,
) => Promise<{ runId: string; task: FactoryTask }>;
const binding = (t: FactoryTask): FactoryBinding => ({
  taskId: t.id,
  issueId: t.issueId,
  attemptId: t.attemptId,
  revision: t.revision,
  candidateId: t.candidateId,
});
const stopped = (task: FactoryTask) =>
  ["cancelled", "revoked"].includes(task.status);
function fail(code: string): never {
  throw new FactoryError(code);
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const p = schema.safeParse(input);
  return p.success ? p.data : fail("factoryInvalid");
}
export const questionReference = (q: FactoryQuestion): QuestionReference => ({
  questionId: q.id,
  questionRevision: q.revision,
  binding: q.waitingBinding,
  originRunId: q.originRunId,
  originSessionId: q.originSessionId,
});

/** Existing Factory/run/event transactions; a question is domain state, not a new queue. */
export function createFactoryQuestions(
  pool: Pool,
  authorize: FactoryAuthorize,
  store: ReturnType<typeof createFactoryStore>,
  dispatch: Dispatch,
) {
  async function transaction<T>(
    fn: (tx: PoolClient) => Promise<T>,
    existing?: PoolClient,
  ): Promise<T> {
    if (existing) {
      try {
        return await fn(existing);
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && e.code === "23505")
          fail("factoryQuestionIdentityConflict");
        throw e;
      }
    }
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const result = await fn(tx);
      await tx.query("COMMIT");
      return result;
    } catch (e) {
      await tx.query("ROLLBACK");
      if (e && typeof e === "object" && "code" in e && e.code === "23505")
        fail("factoryQuestionIdentityConflict");
      throw e;
    } finally {
      tx.release();
    }
  }
  async function ownedTask(tx: PoolClient, userId: string, taskId: string) {
    if (!z.uuid().safeParse(taskId).success) fail("factoryInvalid");
    const {
      rows: [task],
    } = await tx.query<FactoryTask>(
      'SELECT * FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR UPDATE',
      [taskId, userId],
    );
    if (!task || !(await authorize(userId, task.issueId, tx)))
      fail("factoryNotFound");
    return task;
  }
  async function owned(tx: PoolClient, userId: string, questionId: string) {
    if (!z.uuid().safeParse(questionId).success) fail("factoryInvalid");
    const {
      rows: [identity],
    } = await tx.query(
      'SELECT "taskId" FROM factory_questions WHERE id=$1 AND "userId"=$2',
      [questionId, userId],
    );
    if (!identity) fail("factoryNotFound");
    const task = await ownedTask(tx, userId, identity.taskId);
    const {
      rows: [q],
    } = await tx.query<FactoryQuestion>(
      'SELECT * FROM factory_questions WHERE id=$1 AND "userId"=$2 FOR UPDATE',
      [questionId, userId],
    );
    if (!q || q.issueId !== task.issueId) fail("factoryNotFound");
    return { task, q };
  }
  function fence(
    task: FactoryTask,
    q: FactoryQuestion,
    reference: QuestionReference,
  ) {
    if (stopped(task)) fail("factoryStopped");
    if (q.expiresAt && q.expiresAt.getTime() <= Date.now())
      fail("factoryQuestionExpired");
    if (
      reference.questionId !== q.id ||
      reference.originRunId !== q.originRunId ||
      reference.originSessionId !== q.originSessionId ||
      questionFingerprint(reference.binding) !==
        questionFingerprint(q.waitingBinding) ||
      reference.questionRevision !== q.revision ||
      questionFingerprint(binding(task)) !==
        questionFingerprint(q.waitingBinding) ||
      task.status !== "waiting"
    )
      fail("factoryQuestionStale");
    if (!["open", "waiting_user"].includes(q.status))
      fail("factoryQuestionClosed");
  }
  async function human(tx: PoolClient, userId: string, sessionId: string) {
    const { rows } = await tx.query(
      'SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR SHARE',
      [sessionId, userId],
    );
    if (!rows.length) fail("factoryHumanRequired");
  }
  const view = (q: FactoryQuestion) => ({
    ...q,
    reference: questionReference(q),
    thread: { taskId: q.taskId, originRunId: q.originRunId },
  });
  async function currentView(
    tx: PoolClient,
    task: FactoryTask,
    q: FactoryQuestion,
  ) {
    let status: QuestionStatus | null = null;
    if (stopped(task) && !["resolved", "cancelled"].includes(q.status))
      status = "cancelled";
    else if (
      q.expiresAt &&
      q.expiresAt.getTime() <= Date.now() &&
      ["open", "waiting_user"].includes(q.status)
    )
      status = "expired";
    else if (
      task.candidateId !== q.candidateId &&
      !["resolved", "cancelled", "expired"].includes(q.status)
    )
      status = "superseded";
    if (status) {
      const {
        rows: [updated],
      } = await tx.query<FactoryQuestion>(
        'UPDATE factory_questions SET status=$2,reason=$3,revision=revision+1,"updatedAt"=now() WHERE id=$1 RETURNING *',
        [q.id, status, `Question ${status}; continuation is not authorized`],
      );
      q = updated;
    }
    return view(q);
  }
  return {
    async pending(userId: string) {
      const { rows } = await pool.query(
        "SELECT id FROM factory_questions WHERE \"userId\"=$1 AND status IN ('open','waiting_user','resuming','blocked') ORDER BY \"createdAt\" DESC LIMIT 50",
        [userId],
      );
      const result = [];
      for (const row of rows) {
        try {
          result.push(
            await transaction(async (tx) => {
              const { task, q } = await owned(tx, userId, row.id);
              return currentView(tx, task, q);
            }),
          );
        } catch (error) {
          if (
            !(error instanceof FactoryError) ||
            error.code !== "factoryNotFound"
          )
            throw error;
        }
      }
      return result;
    },
    async read(userId: string, questionId: string) {
      return transaction(async (tx) => {
        const { task, q } = await owned(tx, userId, questionId);
        return currentView(tx, task, q);
      });
    },
    async list(userId: string, taskId: string) {
      return transaction(async (tx) => {
        const task = await ownedTask(tx, userId, taskId);
        const { rows } = await tx.query<FactoryQuestion>(
          'SELECT * FROM factory_questions WHERE "taskId"=$1 AND "userId"=$2 ORDER BY "createdAt" DESC LIMIT 50 FOR UPDATE',
          [taskId, userId],
        );
        const result = [];
        for (const q of rows) result.push(await currentView(tx, task, q));
        return result;
      });
    },
    /** Call after the authentic completion is persisted, inside that same transaction. */
    async record(userId: string, runId: string, existing?: PoolClient) {
      return transaction(async (tx) => {
        const {
          rows: [prior],
        } = await tx.query<FactoryQuestion>(
          'SELECT * FROM factory_questions WHERE "originRunId"=$1 AND "userId"=$2',
          [runId, userId],
        );
        const {
          rows: [linked],
        } = prior
          ? { rows: [{ taskId: prior.taskId }] }
          : await tx.query(
              'SELECT t.id AS "taskId" FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE a."runId"=$1 AND t."userId"=$2',
              [runId, userId],
            );
        if (!linked) fail("factoryQuestionUnbound");
        const task = await ownedTask(tx, userId, linked.taskId);
        if (stopped(task)) fail("factoryStopped");
        const {
          rows: [run],
        } = await tx.query(
          'SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR UPDATE',
          [runId, userId, task.issueId],
        );
        if (
          !run ||
          run.status !== "stopped" ||
          !["asked_human", "blocked"].includes(run.stopReason) ||
          !run.sessionId ||
          run.stopRequestedAt
        )
          fail("factoryQuestionRunMismatch");
        const handoff: QuestionHandoff = run.report?.question
          ? parse(questionHandoffSchema, run.report.question)
          : questionHandoffSchema.parse({
              questionId: legacyQuestionId(runId),
              kind: run.stopReason === "blocked" ? "external" : "decision",
              question: (
                run.report?.openQuestions?.join("\n") ||
                run.report?.blockedOn ||
                "Missing execution input"
              ).slice(0, 4000),
              context: String(run.report?.summary ?? "").slice(0, 4000),
            });
        const request = {
          handoff,
          originRunId: runId,
          originSessionId: run.sessionId,
        };
        const {
          rows: [duplicate],
        } = await tx.query<FactoryQuestion>(
          'SELECT * FROM factory_questions WHERE "originRunId"=$1 FOR UPDATE',
          [runId],
        );
        if (duplicate) {
          if (
            duplicate.userId !== userId ||
            questionFingerprint(duplicate.request) !==
              questionFingerprint(request)
          )
            fail("factoryReplayMismatch");
          return currentView(tx, task, duplicate);
        }
        if (
          task.status !== "running" ||
          !["spec", "execute", "review", "verify", "monitor"].includes(
            task.stage,
          )
        )
          fail("factoryTransition");
        const {
          rows: [attempt],
        } = await tx.query(
          'SELECT * FROM factory_attempts WHERE id=$1 AND "taskId"=$2 AND "runId"=$3',
          [task.attemptId, task.id, runId],
        );
        if (!attempt || attempt.candidateId !== task.candidateId)
          fail("factoryQuestionRunMismatch");
        const eventId = factoryEventId(
          "execution-question",
          handoff.questionId,
        );
        await tx.query(
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId","runId",payload) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT ("dedupeKey") DO NOTHING`,
          [
            eventId,
            userId,
            run.stopReason === "blocked" ? "run_blocked" : "run_question",
            `execution-question:${handoff.questionId}`,
            task.issueId,
            runId,
            JSON.stringify({
              ...handoff,
              reason: handoff.question,
              taskId: task.id,
              originRunId: runId,
              originSessionId: run.sessionId,
              assessment: "orchestrator_first",
            }),
          ],
        );
        const state = await store.apply(
          userId,
          binding(task),
          factoryEventId("question-wait", handoff.questionId),
          {
            action: "finish",
            status: "waiting",
            reason: handoff.question,
            evidence: [],
            output: { ...attempt.output, questionId: handoff.questionId },
          },
          tx,
        );
        const {
          rows: [q],
        } = await tx.query<FactoryQuestion>(
          `INSERT INTO factory_questions (id,"userId","issueId","taskId","attemptId","candidateId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,context,options,request,status,reason,"sourceEventId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'open',$13,$17) RETURNING *`,
          [
            handoff.questionId,
            userId,
            task.issueId,
            task.id,
            task.attemptId,
            task.candidateId,
            task.stage,
            runId,
            run.sessionId,
            task.revision,
            JSON.stringify(binding(state.task)),
            handoff.kind,
            handoff.question,
            handoff.context ?? "",
            JSON.stringify(handoff.options),
            JSON.stringify(request),
            eventId,
          ],
        );
        return view(q);
      }, existing);
    },
    async escalate(userId: string, raw: unknown) {
      const input = parse(questionEscalationSchema, raw);
      return transaction(async (tx) => {
        const { task, q } = await owned(tx, userId, input.reference.questionId);
        if (stopped(task)) fail("factoryStopped");
        if (q.escalationEventId) {
          if (
            q.escalationEventId !== input.eventId ||
            questionFingerprint(q.escalationRequest) !==
              questionFingerprint(input)
          )
            fail("factoryReplayMismatch");
          return currentView(tx, task, q);
        }
        fence(task, q, input.reference);
        const eventId = factoryEventId("question-escalated", q.id);
        await tx.query(
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId","runId",payload) VALUES ($1,$2,'run_question',$3,$4,$5,$6) ON CONFLICT ("dedupeKey") DO NOTHING`,
          [
            eventId,
            userId,
            `question-escalated:${q.id}`,
            q.issueId,
            q.originRunId,
            JSON.stringify({
              questionId: q.id,
              question: q.question,
              options: q.options,
              taskId: q.taskId,
              needsUser: true,
              reason: input.reason,
            }),
          ],
        );
        const {
          rows: [updated],
        } = await tx.query<FactoryQuestion>(
          'UPDATE factory_questions SET status=\'waiting_user\',reason=$2,"escalationEventId"=$3,"escalationRequest"=$4,revision=revision+1,"updatedAt"=now() WHERE id=$1 RETURNING *',
          [q.id, input.reason, input.eventId, JSON.stringify(input)],
        );
        return view(updated);
      });
    },
    async answer(
      actor: QuestionActor,
      raw: unknown,
    ): Promise<QuestionContinuation> {
      const input =
        actor.source === "orchestrator"
          ? parse(contextQuestionAnswerSchema, raw)
          : parse(humanQuestionAnswerSchema, raw);
      return transaction(async (tx) => {
        const { task, q } = await owned(
          tx,
          actor.userId,
          input.reference.questionId,
        );
        if (stopped(task)) fail("factoryStopped");
        if (task.candidateId !== q.candidateId) fail("factoryQuestionStale");
        let answerText = "",
          sourceEventId: string | null = null;
        if (actor.source === "human") {
          await human(tx, actor.userId, actor.sessionId);
          answerText = (input as z.infer<typeof humanQuestionAnswerSchema>)
            .text;
        } else if (actor.source === "human_event") {
          const answer = input as z.infer<typeof humanQuestionAnswerSchema>;
          if (!answer.sourceEventId) fail("factoryHumanRequired");
          const {
            rows: [event],
          } = await tx.query(
            `SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND kind='user_message' AND ("issueId" IS NULL OR "issueId"=$3) FOR SHARE`,
            [answer.sourceEventId, actor.userId, q.issueId],
          );
          if (
            !event?.payload?.humanSessionId ||
            event.payload.text !== answer.text ||
            event.createdAt < q.createdAt
          )
            fail("factoryHumanRequired");
          await human(tx, actor.userId, event.payload.humanSessionId);
          if (event.payload.questionId && event.payload.questionId !== q.id)
            fail("factoryQuestionStale");
          if (!event.payload.questionId && !q.answerId) {
            const { rows } = await tx.query(
              `SELECT id FROM factory_questions WHERE "userId"=$1 AND status='waiting_user' AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())`,
              [actor.userId],
            );
            if (rows.length !== 1 || rows[0].id !== q.id)
              fail("factoryQuestionAmbiguous");
          }
          answerText = answer.text;
          sourceEventId = answer.sourceEventId;
        } else {
          if (!orchestratorMayAnswer(q.kind))
            fail("factoryQuestionHumanRequired");
          const answer = input as z.infer<typeof contextQuestionAnswerSchema>;
          const excerpts: string[] = [];
          for (const fact of answer.facts) {
            let source = "";
            if (fact.kind === "issue") {
              const {
                rows: [issue],
              } = await tx.query(
                'SELECT title,content FROM issues WHERE id=$1 AND "userId"=$2',
                [q.issueId, actor.userId],
              );
              if (issue)
                source = `${issue.title}\n${tiptapToText(issue.content)}`;
            } else {
              const {
                rows: [event],
              } = await tx.query(
                `SELECT payload FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND kind='user_message' AND ("issueId" IS NULL OR "issueId"=$3)`,
                [fact.sourceEventId, actor.userId, q.issueId],
              );
              source = String(event?.payload?.text ?? "");
            }
            if (!source.includes(fact.quote))
              fail("factoryQuestionFactMismatch");
            excerpts.push(fact.quote);
          }
          answerText = excerpts.join("\n");
          if (answerText.length > 4000) fail("factoryInvalid");
        }
        const request = { source: actor.source, userId: actor.userId, input };
        const fingerprint = questionFingerprint(request);
        if (q.answerId) {
          if (
            q.answerId !== input.answerId ||
            q.answerFingerprint !== fingerprint ||
            !q.result
          )
            fail("factoryQuestionAnswerConflict");
          return { ...q.result, replayed: true };
        }
        fence(task, q, input.reference);
        const {
          rows: [origin],
        } = await tx.query(
          'SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR UPDATE',
          [q.originRunId, actor.userId, q.issueId],
        );
        if (
          !origin ||
          origin.status !== "stopped" ||
          origin.sessionId !== q.originSessionId ||
          origin.stopRequestedAt ||
          !origin.deviceRepoId ||
          !origin.agentId ||
          !origin.deviceId
        )
          fail("factoryQuestionRunMismatch");
        // Each shared consumer must retain its own read-only/target adapter when continuing.
        if (
          !["spec", "execute", "review", "verify", "monitor"].includes(
            task.stage,
          )
        )
          fail("factoryQuestionContinuationUnavailable");
        const followUp = `Answer to execution question ${q.id}.\nQuestion: ${q.question}\nSource: ${actor.source}.\nAnswer: ${answerText}\nContinue the original task with all existing constraints. This input grants no new permission or publication approval.`;
        await tx.query(
          `UPDATE factory_questions SET status='answered',"answerId"=$2,"answerSource"=$3,"answerSourceEventId"=$4,answer=$5,"answerFingerprint"=$6,"answeredAt"=now(),revision=revision+1,"updatedAt"=now() WHERE id=$1`,
          [
            q.id,
            input.answerId,
            actor.source,
            sourceEventId,
            JSON.stringify(request),
            fingerprint,
          ],
        );
        const next = await store.apply(
          actor.userId,
          binding(task),
          factoryEventId("question-next-attempt", q.id),
          {
            action: "retry",
            reason: `Answer received for question ${q.id}; continue original session`,
          },
          tx,
        );
        const run = await dispatch(
          actor.userId,
          {
            binding: binding(next.task),
            agentId: origin.agentId,
            deviceRepoId: origin.deviceRepoId,
            note: followUp,
          },
          tx,
        );
        const {
          rows: [queued],
        } = await tx.query(
          'SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE',
          [run.runId, actor.userId],
        );
        if (
          !queued ||
          queued.deviceId !== origin.deviceId ||
          queued.status !== "queued"
        )
          fail("factoryQuestionContinuationUnavailable");
        const continuation = {
          questionId: q.id,
          originRunId: q.originRunId,
          originSessionId: q.originSessionId,
          followUp,
          requireSessionResume: true,
        };
        await tx.query(
          'UPDATE agent_runs SET "questionContinuation"=$2,"accountActionRefs"=$3 WHERE id=$1',
          [run.runId, JSON.stringify(continuation), JSON.stringify(origin.accountActionRefs ?? [])],
        );
        const result: QuestionContinuation = {
          questionId: q.id,
          continuationRunId: run.runId,
          task: run.task,
          replayed: false,
        };
        await tx.query(
          `UPDATE factory_questions SET status='resuming',"continuationRunId"=$2,result=$3,"updatedAt"=now() WHERE id=$1`,
          [q.id, run.runId, JSON.stringify(result)],
        );
        // A task-thread answer is retained in the addressed run, not stranded in its old inbox.
        await tx.query(
          `INSERT INTO run_messages (id,"runId","userId",text,"deliveredAt") VALUES ($1,$2,$3,$4,now()) ON CONFLICT (id) DO NOTHING`,
          [input.answerId, q.originRunId, actor.userId, answerText],
        );
        return result;
      });
    },
    async claimContinuation(
      userId: string,
      deviceId: string,
      runId: string,
      leaseExpiresAt: string,
    ) {
      return transaction(async (tx) => {
        const {
          rows: [identity],
        } = await tx.query(
          'SELECT id FROM factory_questions WHERE "continuationRunId"=$1 AND "userId"=$2',
          [runId, userId],
        );
        if (!identity) fail("factoryQuestionContinuationUnavailable");
        const { task, q } = await owned(tx, userId, identity.id);
        if (stopped(task)) fail("factoryStopped");
        if (
          q.status !== "resuming" ||
          task.status !== "running" ||
          task.candidateId !== q.candidateId ||
          (q.expiresAt && q.expiresAt.getTime() <= Date.now())
        )
          fail("factoryQuestionStale");
        const {
          rows: [run],
        } = await tx.query(
          `SELECT r.*,a."runId" AS "boundRunId",origin."deviceId" AS "originDeviceId",origin."sessionId" AS "originSessionId",origin."agentId" AS "originAgentId",origin."deviceRepoId" AS "originRepoId",d.enabled,d."lastSeenAt",d.harnesses,ag.harness FROM agent_runs r JOIN factory_attempts a ON a.id=$3 AND a."taskId"=$4 JOIN agent_runs origin ON origin.id=$5 AND origin."userId"=$2 AND origin."issueId"=$6 JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=$2 JOIN agents ag ON ag.id=r."agentId" AND ag."userId"=$2 AND ag."deviceId"=d.id JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=$2 AND repo."deviceId"=d.id WHERE r.id=$1 AND r."userId"=$2 AND r."issueId"=$6 FOR UPDATE OF r FOR SHARE OF d,ag,repo`,
          [runId, userId, task.attemptId, task.id, q.originRunId, q.issueId],
        );
        const c = run?.questionContinuation;
        if (
          !run ||
          run.status !== "queued" ||
          run.stopRequestedAt ||
          run.boundRunId !== runId ||
          run.deviceId !== deviceId ||
          run.originDeviceId !== deviceId ||
          run.originAgentId !== run.agentId ||
          run.originRepoId !== run.deviceRepoId ||
          run.originSessionId !== q.originSessionId ||
          !run.enabled ||
          !run.lastSeenAt ||
          Date.now() - run.lastSeenAt.getTime() > DEVICE_ONLINE_WINDOW_MS ||
          !run.harnesses?.some(
            (h: { harness: string; installed: boolean }) =>
              h.harness === run.harness && h.installed,
          ) ||
          c?.questionId !== q.id ||
          c.originRunId !== q.originRunId ||
          c.originSessionId !== q.originSessionId ||
          c.requireSessionResume !== true
        )
          fail("factoryQuestionContinuationUnavailable");
        const check =
          run.kind === "acceptance"
            ? await factoryCheckAssignment(tx, userId, runId)
            : {};
        await tx.query(
          'UPDATE agent_runs SET status=\'preparing\',"startedAt"=now(),"leaseExpiresAt"=$2,"updatedAt"=now() WHERE id=$1',
          [runId, leaseExpiresAt],
        );
        return {
          ...check,
          continuesRunId: q.originRunId,
          resumeSessionId: q.originSessionId,
          followUp: c.followUp as string,
          requireSessionResume: true as const,
          questionId: q.id,
        };
      });
    },
    async settle(userId: string, runId: string, existing?: PoolClient) {
      return transaction(async (tx) => {
        const {
          rows: [identity],
        } = await tx.query(
          'SELECT id FROM factory_questions WHERE "continuationRunId"=$1 AND "userId"=$2',
          [runId, userId],
        );
        if (!identity) return null;
        const { task, q } = await owned(tx, userId, identity.id);
        if (
          ["resolved", "cancelled", "expired", "superseded"].includes(q.status)
        )
          return view(q);
        const {
          rows: [run],
        } = await tx.query(
          'SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR UPDATE',
          [runId, userId, q.issueId],
        );
        if (
          run &&
          !["succeeded", "failed", "stopped", "cancelled"].includes(run.status)
        )
          return view(q);
        const cancelled =
          stopped(task) ||
          run?.stopRequestedAt ||
          run?.status === "cancelled" ||
          run?.stopReason === "cancelled";
        const resumed =
          run &&
          run.sessionId === q.originSessionId &&
          ["submitted", "asked_human", "blocked", "turn_ended"].includes(
            run.stopReason,
          );
        const status = cancelled
          ? "cancelled"
          : resumed
            ? "resolved"
            : "blocked";
        const reason = cancelled
          ? "Continuation cancelled; no automatic resume"
          : resumed
            ? "Answer delivered through the original session"
            : "Original session continuation failed; explicit recovery required";
        const {
          rows: [updated],
        } = await tx.query<FactoryQuestion>(
          'UPDATE factory_questions SET status=$2,reason=$3,revision=revision+1,"updatedAt"=now() WHERE id=$1 RETURNING *',
          [q.id, status, reason],
        );
        if (status === "blocked" && task.status === "running") {
          const {
            rows: [attempt],
          } = await tx.query(
            'SELECT * FROM factory_attempts WHERE id=$1 AND "runId"=$2',
            [task.attemptId, runId],
          );
          if (attempt)
            await store.apply(
              userId,
              binding(task),
              factoryEventId("question-resume-failed", q.id),
              {
                action: "finish",
                status: "blocked",
                reason,
                evidence: [],
                output: { ...attempt.output, questionId: q.id },
              },
              tx,
            );
        }
        return view(updated);
      }, existing);
    },
  };
}
