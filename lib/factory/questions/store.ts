import { actingContext } from '@/lib/activity-actor';
import { remoteKey } from "@mikka/protocol/repository";
import { factoryChanged } from "../../live/factory";
import { runChanged } from "../../live/panels";
import { runListChanged } from '../../live/lists';
import { advanceTaskAfterRunStart } from '../../task-status-run-start';
import { wakeCoordinatorAfterCommit } from '../../coordinator/wake-after-commit';
import { notifyQueuedLocalRun } from '../../device-gateway-notify';
import { appendFactoryCheckContinuationContext, factoryCheckAssignment, factoryReportQuestionAssignment } from "../checks";
import { factoryMonitorDispatchAssignment } from "../monitor-dispatch";
import { personalRunMessageText } from "../../personal-run-message";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { deviceIsOnline } from "../../device-presence";
import { FactoryError, type FactoryBinding } from "../contract";
import { factoryEventId } from "../event-id";
import { admitCloudQuestionContinuation } from "./queue-continuation";
import { questionPlanContinuation, unclaimedPlanQuestionContinuation } from "./execution-continuation";
import { questionAnswerPrompt } from "./answer-prompt";
import type {
  createFactoryStore,
  FactoryAuthorize,
  FactoryTask,
} from "../store";
import type { FactoryDispatchInput } from "../dispatch";
import { tiptapToText } from "../../tiptap-text";
import {
  contextQuestionAnswerSchema,
  humanQuestionAnswerSchema,
  questionEscalationSchema,
  questionRecoverySchema,
  questionHandoffSchema,
  legacyQuestionId,
  orchestratorMayAnswer,
  questionClosed,
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
export interface QuestionSkillGuards {
  lockAnswer?: (userId:string,questionId:string,tx:PoolClient)=>Promise<void>;
  lockOrigin: (userId:string,issueId:string,runId:string,tx:PoolClient)=>Promise<void>;
  continueQuestion: (userId:string,runId:string,tx:PoolClient)=>Promise<void>;
}
export type QuestionActor =
  | { source: "human"; userId: string; sessionId: string }
  | { source: "human_event"; userId: string }
  | { source: "orchestrator"; userId: string };
type Dispatch = (
  userId: string,
  input: FactoryDispatchInput,
  tx?: PoolClient,
  questionOriginRunId?: string,
  questionHistoryRunId?: string,
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

/** Called only after the immutable question receipt proves the accepted
 * answer was never delivered to a native session. No new answer is recorded. */
function undeliveredQuestionAnswerPrompt(q: FactoryQuestion): string {
  const source = q.answerSource;
  if (source !== "human" && source !== "human_event" && source !== "orchestrator") fail("factoryQuestionContinuationUnavailable");
  const input = (q.answer as { input?: unknown } | null)?.input;
  const answer = source === "orchestrator" ? parse(contextQuestionAnswerSchema, input) : parse(humanQuestionAnswerSchema, input);
  const text = "text" in answer ? answer.text : answer.facts.map(fact => fact.quote).join("\n");
  return questionAnswerPrompt({ questionId: q.id, question: q.question, answerId: answer.answerId, answerSource: source,
    answerText: personalRunMessageText(answer.answerId, text, source === "orchestrator" ? "peer" : "user") });
}

/** Existing Factory/run/event transactions; a question is domain state, not a new queue. */
export function createFactoryQuestions(
  pool: Pool,
  authorize: FactoryAuthorize,
  store: ReturnType<typeof createFactoryStore>,
  dispatch: Dispatch,
  validateCheckOrSkills?: ((tx: PoolClient, task: FactoryTask, runId: string) => Promise<Record<string, unknown>>) | QuestionSkillGuards,
  skillGuards?: QuestionSkillGuards,
  afterContinuation?: (userId: string, result: QuestionContinuation) => Promise<void>,
  beforeRecovery?: (userId: string, scope: { runId: string; workspaceId: string }) => Promise<void>,
) {
  const skills = typeof validateCheckOrSkills === "object" ? validateCheckOrSkills : skillGuards;
  const validateCheck = typeof validateCheckOrSkills === "function" ? validateCheckOrSkills : (tx:PoolClient,task:FactoryTask,id:string) => task.stage === "monitor" ? factoryMonitorDispatchAssignment(tx,task.userId,id) : factoryCheckAssignment(tx,task.userId,id);
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
  async function ownedTask(tx: PoolClient, userId: string, taskId: string, lock = true, readScope: "bot" | "user" = "bot") {
    return lock ? store.lockTask(tx, userId, taskId)
      : readScope === "user" ? store.readTaskForUser(tx, userId, taskId) : store.readTask(tx, userId, taskId);
  }

  /** Keep the task-before-question lock order for writes. */
  async function owned(tx: PoolClient, userId: string, questionId: string, lock = true) {
    if (!z.uuid().safeParse(questionId).success) fail("factoryInvalid");
    const { rows: [identity] } = await tx.query<{ taskId: string }>(
      'SELECT "taskId" FROM factory_questions WHERE id=$1 AND "userId"=$2',
      [questionId, userId],
    );
    if (!identity) fail("factoryNotFound");
    return ownedForTask(tx, userId, questionId, identity.taskId, lock);
  }

  async function ownedForTask(tx: PoolClient, userId: string, questionId: string, taskId: string, lock: boolean, readScope: "bot" | "user" = "bot") {
    const task = await ownedTask(tx, userId, taskId, lock, readScope);
    const { rows: [q] } = await tx.query<FactoryQuestion>(
      lock
        ? 'SELECT * FROM factory_questions WHERE id=$1 AND "userId"=$2 FOR UPDATE'
        : 'SELECT * FROM factory_questions WHERE id=$1 AND "userId"=$2',
      [questionId, userId],
    );
    if (!q || q.taskId !== task.id || q.issueId !== task.issueId) fail("factoryNotFound");
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
  const view = (q: FactoryQuestion): FactoryQuestion & { reference: QuestionReference; thread: {taskId:string;originRunId:string}; recoverReference?: {expectedFailedRunId:string;reference:QuestionReference} | null } => ({
    ...q,
    reference: questionReference(q),
    thread: { taskId: q.taskId, originRunId: q.originRunId },
  });
  /** Effective status from the clock and the task. GETs pass persist=false and
   * write nothing (Tech Lead: GETs are strictly read-only); write paths persist. */
  async function currentView(
    tx: PoolClient,
    task: FactoryTask,
    q: FactoryQuestion,
    persist = true,
  ): Promise<ReturnType<typeof view>> {
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
    if (status && !persist)
      q = {
        ...q,
        status,
        reason: `Question ${status}; continuation is not authorized`,
      };
    else if (status) {
      const {
        rows: [updated],
      } = await tx.query<FactoryQuestion>(
        'UPDATE factory_questions SET status=$2,reason=$3,revision=revision+1,"updatedAt"=now() WHERE id=$1 RETURNING *',
        [q.id, status, `Question ${status}; continuation is not authorized`],
      );
      q = updated;
      await factoryChanged(tx, task);
    }
    return { ...view(q), recoverReference:
      q.status === 'blocked' && task.status === 'blocked' && q.answerId && q.continuationRunId && task.candidateId === q.candidateId
        ? { expectedFailedRunId: q.continuationRunId, reference: { ...questionReference(q), binding: binding(task) } }
        : null };
  }
  return {
    /** The tenant and optional run are filtered in SQL before the newest-50 cap. */
    async pending(userId: string, runId?: string, readScope: "bot" | "user" = "bot") {
      const actor = actingContext.getStore();
      const workspaceId = actor?.userId === userId ? actor.tokenWorkspaceId : undefined;
      const { rows } = await pool.query<{ id: string; taskId: string }>(
        `SELECT q.id, q."taskId" FROM factory_questions q
          JOIN factory_tasks t ON t.id=q."taskId" AND t."userId"=q."userId" AND t."issueId"=q."issueId"
          JOIN issues i ON i.id=t."issueId" AND i."ownershipState"='bound' AND i."workspaceId"=t."workspaceId"
          WHERE q."userId"=$1 AND q.status IN ('open','waiting_user','resuming','blocked')
            AND NOT (q.status IN ('open','waiting_user') AND q."expiresAt" IS NOT NULL AND q."expiresAt"<=clock_timestamp())
            AND ($2::uuid IS NULL OR q."originRunId"=$2::uuid OR q."continuationRunId"=$2::uuid)
            AND ($3::uuid IS NULL OR t."workspaceId"=$3::uuid)
          ORDER BY q."createdAt" DESC, q.id DESC LIMIT 50`,
        [userId, runId ?? null, workspaceId ?? null],
      );
      const result = [];
      for (const row of rows) {
        try {
          result.push(
            await transaction(async (tx) => {
              const { task, q } = await ownedForTask(tx, userId, row.id, row.taskId, false, readScope);
              return currentView(tx, task, q, false);
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
        const { task, q } = await owned(tx, userId, questionId, false);
        return currentView(tx, task, q, false);
      });
    },
    async list(userId: string, taskId: string, readScope: "bot" | "user" = "bot") {
      return transaction(async (tx) => {
        const task = await ownedTask(tx, userId, taskId, false, readScope);
        const { rows } = await tx.query<FactoryQuestion>(
          'SELECT * FROM factory_questions WHERE "taskId"=$1 AND "userId"=$2 ORDER BY "createdAt" DESC, id DESC LIMIT 50',
          [taskId, userId],
        );
        const result = [];
        for (const q of rows) result.push(await currentView(tx, task, q, false));
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
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId","runId",payload,"botId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("dedupeKey") DO NOTHING`,
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
            task.botId,
          ],
        );
        wakeCoordinatorAfterCommit(tx, userId);
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
          `INSERT INTO factory_questions (id,"userId","issueId","taskId","attemptId","candidateId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,context,options,request,status,reason,"sourceEventId","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'open',$13,$17,now()+interval '24 hours') RETURNING *`,
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
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId","runId",payload,"botId") VALUES ($1,$2,'run_question',$3,$4,$5,$6,$7) ON CONFLICT ("dedupeKey") DO NOTHING`,
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
            task.botId,
          ],
        );
        wakeCoordinatorAfterCommit(tx, userId);
        const {
          rows: [updated],
        } = await tx.query<FactoryQuestion>(
          'UPDATE factory_questions SET status=\'waiting_user\',reason=$2,"escalationEventId"=$3,"escalationRequest"=$4,revision=revision+1,"updatedAt"=now() WHERE id=$1 RETURNING *',
          [q.id, input.reason, input.eventId, JSON.stringify(input)],
        );
        await factoryChanged(tx, task);
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
      const result = await transaction(async (tx) => {
        await skills?.lockAnswer?.(actor.userId, input.reference.questionId, tx);
        const { task, q } = await owned(
          tx,
          actor.userId,
          input.reference.questionId,
        );
        if (stopped(task)) fail("factoryStopped");
        if (q.expiresAt && q.expiresAt.getTime() <= Date.now()) fail("factoryQuestionExpired");
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
            `SELECT * FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND kind='user_message' AND ("issueId" IS NULL OR "issueId"=$3) AND "botId" IS NOT DISTINCT FROM $4::uuid FOR SHARE`,
            [answer.sourceEventId, actor.userId, q.issueId, task.botId],
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
              `SELECT q.id FROM factory_questions q JOIN factory_tasks t ON t.id=q."taskId" WHERE q."userId"=$1 AND t."botId" IS NOT DISTINCT FROM $2::uuid AND q.status='waiting_user' AND (q."expiresAt" IS NULL OR q."expiresAt">clock_timestamp())`,
              [actor.userId,task.botId],
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
              if (fact.sourceEventId !== task.sourceEventId) fail("factoryQuestionFactMismatch");
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
        await skills?.lockOrigin(actor.userId, q.issueId, q.originRunId, tx);
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
        // A model's purpose flag is not command authority. Preserve its handoff,
        // but let the frozen host assignment decide how a human answer is used.
        if ((q.request as { handoff?: QuestionHandoff })?.handoff?.purpose === "verification_command") {
          if (actor.source === "orchestrator") fail("factoryHumanRequired");
          const { rows: [checkAttempt] } = await tx.query(`SELECT a.output,c.kind AS "candidateKind"
            FROM factory_attempts a JOIN factory_candidates c ON c.id=a."candidateId" AND c."taskId"=a."taskId"
            WHERE a.id=$1 AND a."taskId"=$2 AND a."runId"=$3`, [q.attemptId, task.id, origin.id]);
          if (["deliverable", "report"].includes(checkAttempt?.candidateKind)) {
            // Existing waiting questions keep their request/report. The complete
            // candidate/SHA/repo/Bot/policy reader admits only report-only checks.
            await factoryReportQuestionAssignment(tx, actor.userId, origin.id);
          } else {
            if (task.stage !== "verify") fail("factoryHumanRequired");
            const command = answerText.trim();
            if (!command || command.length > 2000 || (/[\r\n]/.test(command) || command.includes('\0'))) fail("factoryInvalid");
            if (checkAttempt?.candidateKind !== "repository" || checkAttempt.output?.check?.inferCommand !== true ||
              checkAttempt.output.check.reportOnly !== false || checkAttempt.output.check.command) fail("factoryQuestionRunMismatch");
            const { rows: [repo] } = await tx.query('SELECT "remoteUrl" FROM device_repos WHERE id=$1 AND "userId"=$2 FOR UPDATE', [origin.deviceRepoId, actor.userId]);
            if (!repo) fail("factoryQuestionRunMismatch");
            await tx.query('UPDATE device_repos SET "verifyCommand"=$3 WHERE id=$1 AND "userId"=$2', [origin.deviceRepoId, actor.userId, command]);
            if (repo.remoteUrl) await tx.query(`INSERT INTO repository_settings ("userId","remoteKey","verifyCommand") VALUES ($1,$2,$3)
              ON CONFLICT ("userId","remoteKey") DO UPDATE SET "verifyCommand"=excluded."verifyCommand","updatedAt"=now()`, [actor.userId, remoteKey(repo.remoteUrl), command]);
          }
        }
        const attributedAnswer = personalRunMessageText(input.answerId, answerText, actor.source === "human" || actor.source === "human_event" ? "user" : "peer");
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
        const followUp = questionAnswerPrompt({ questionId: q.id, question: q.question,
          answerId: input.answerId, answerSource: actor.source, answerText: attributedAnswer });
        const next = task.stage === 'execute'
          ? await store.retryQuestion(actor.userId, binding(task), factoryEventId("question-next-attempt", q.id),
            `Answer received for question ${q.id}; continue original session`, q.id, tx)
          : await store.apply(
            actor.userId,
            binding(task),
            factoryEventId("question-next-attempt", q.id),
            { action: "retry", reason: `Answer received for question ${q.id}; continue original session` },
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
          q.originRunId,
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
          queued.agentId !== origin.agentId || queued.deviceRepoId !== origin.deviceRepoId ||
          queued.baseBranch !== origin.baseBranch ||
          !origin.agentDefinition || !queued.agentDefinition ||
          queued.agentDefinition.definitionDigest !== origin.agentDefinition.definitionDigest ||
          queued.status !== "queued"
        )
          fail("factoryQuestionContinuationUnavailable");
        const { rows: [machine] } = await tx.query('SELECT "sandboxId" FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2',[run.runId,actor.userId]);
        const continuation = {
          ...(machine?.sandboxId ? {requiredSandboxId: machine.sandboxId as string} : {}),
          questionId: q.id,
          originRunId: q.originRunId,
          originSessionId: q.originSessionId,
          followUp: await appendFactoryCheckContinuationContext(tx, run.task, run.runId, followUp),
          requireSessionResume: true,
        };
        await tx.query(
          'UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1',
          [run.runId, JSON.stringify(continuation)],
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
        // This host receipt binds a question answer to one direct execution
        // continuation. It commits with the answer and cannot be reconstructed
        // later from a shared SID or the mutable question status.
        await tx.query('INSERT INTO factory_events ("taskId","eventId",request,result) VALUES($1,$2,$3,$4)', [
          task.id, factoryEventId('question-resume', input.answerId),
          JSON.stringify({ kind: 'question_resume', ...request }),
          JSON.stringify({ questionId: q.id, answerId: input.answerId, answerFingerprint: fingerprint,
            originRunId: q.originRunId, originSessionId: q.originSessionId, originAttemptId: q.attemptId,
            continuationRunId: run.runId, task: run.task }),
        ]);
        await skills?.continueQuestion(actor.userId, run.runId, tx);
        // A task-thread answer is retained in the addressed run, not stranded in its old inbox.
        await tx.query(
          `INSERT INTO run_messages (id,"runId","userId",text,"deliveredAt") VALUES ($1,$2,$3,$4,now()) ON CONFLICT (id) DO NOTHING`,
          [input.answerId, q.originRunId, actor.userId, attributedAnswer],
        );
        return result;
      });
      // The answer and its exact continuation are durable before waking a
      // paused machine. Replaying the same answer may retry this same wake.
      await notifyQueuedLocalRun(pool, actor.userId, result.continuationRunId);
      try { await afterContinuation?.(actor.userId,result); }
      catch { console.error(JSON.stringify({msg:'factory_question_wake_deferred',runId:result.continuationRunId})); }
      return result;
    },
    /** Recover a failed strict continuation; ordinary answer replay remains immutable. */
    async recover(actor: { source: "human"; userId: string; sessionId: string }, raw: unknown): Promise<QuestionContinuation> {
      if(actor.source!=="human") fail("factoryHumanRequired");
      const input = parse(questionRecoverySchema, raw);
      const eventId = factoryEventId('question-recover',input.requestId);
      const request = { kind:'question_recover',userId:actor.userId,input };
      const prepare = async (tx: PoolClient) => {
        await skills?.lockAnswer?.(actor.userId,input.reference.questionId,tx);
        const {task,q}=await owned(tx,actor.userId,input.reference.questionId);
        await human(tx,actor.userId,actor.sessionId);
        if(stopped(task)) fail('factoryStopped');
        const {rows:[receipt]}=await tx.query('SELECT request=$3::jsonb AS same,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2',[task.id,eventId,JSON.stringify(request)]);
        if(receipt) {
          if(!receipt.same) fail('factoryReplayMismatch');
          return { kind:'replay' as const, result:{...receipt.result,replayed:true} as QuestionContinuation };
        }
        if(q.expiresAt && q.expiresAt.getTime()<=Date.now()) fail('factoryQuestionExpired');
        if(q.status!=='blocked' || task.status!=='blocked' || !q.answerId || !q.answerFingerprint || !q.result ||
          q.continuationRunId!==input.expectedFailedRunId || task.candidateId!==q.candidateId ||
          questionFingerprint(input.reference)!==questionFingerprint({...questionReference(q),binding:binding(task)})) fail('factoryQuestionStale');
        await skills?.lockOrigin(actor.userId,q.issueId,q.originRunId,tx);
        const {rows:runs}=await tx.query('SELECT * FROM agent_runs WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND "issueId"=$3 ORDER BY id FOR UPDATE',[[q.originRunId,input.expectedFailedRunId],actor.userId,q.issueId]);
        const origin=runs.find(r=>r.id===q.originRunId),failed=runs.find(r=>r.id===input.expectedFailedRunId);
        const {rows:[attempt]}=await tx.query('SELECT "runId" FROM factory_attempts WHERE id=$1 AND "taskId"=$2',[task.attemptId,task.id]);
        const c=failed?.questionContinuation;
        const unclaimed = failed?.sessionId === null ? await unclaimedPlanQuestionContinuation(tx,task,failed.id) : null;
        if(!origin || !failed || attempt?.runId!==failed.id || failed.status!=='failed' || failed.stopRequestedAt || origin.stopRequestedAt ||
          (failed.sessionId!==q.originSessionId && !unclaimed) || origin.sessionId!==q.originSessionId ||
          c?.questionId!==q.id || c.originRunId!==q.originRunId || c.originSessionId!==q.originSessionId || c.requireSessionResume!==true ||
          ['deviceId','deviceRepoId','agentId','baseBranch'].some(k=>failed[k]!==origin[k]) ||
          !origin.agentDefinition || !failed.agentDefinition || origin.agentDefinition.definitionDigest!==failed.agentDefinition.definitionDigest ||
          questionFingerprint(origin.agentDefinition.subscription ?? null)!==questionFingerprint(failed.agentDefinition.subscription ?? null)) fail('factoryQuestionContinuationUnavailable');
        const {rows:[scope]}=await tx.query(`SELECT 1 FROM computer_run_bindings origin
          JOIN computer_run_bindings latest ON latest."runId"=$2 AND latest."ownerId"=origin."ownerId"
            AND latest."workspaceId"=origin."workspaceId" AND latest."botId"=origin."botId"
          WHERE origin."runId"=$1 AND origin."ownerId"=$3`,[q.originRunId,failed.id,actor.userId]);
        if(!scope) fail('factoryQuestionContinuationUnavailable');
        const admitted = await admitCloudQuestionContinuation(tx,actor.userId,
          {issueId:q.issueId,agentId:failed.agentId,deviceRepoId:failed.deviceRepoId},task.botId,
          {attemptId:task.attemptId,sourceEventId:task.sourceEventId,questionOriginRunId:q.originRunId,questionHistoryRunId:failed.id},'blocked');
        if(!admitted) fail('factoryQuestionContinuationUnavailable');
        return { kind:'admitted' as const, task,q,failed,c,
          undeliveredAnswer: unclaimed?.historyRunId === q.originRunId ? undeliveredQuestionAnswerPrompt(q) : null,
          scope:{runId:failed.id as string,workspaceId:admitted.binding.workspaceId as string} };
      };
      // Validate before provider I/O, then release all transaction locks. The
      // same admission runs again before dispatch; an old receipt never touches
      // its now-transferred VM. Only trusted host wiring supplies this hook.
      const prepared = beforeRecovery ? await transaction(prepare) : null;
      if(prepared?.kind==='admitted' && beforeRecovery) await beforeRecovery(actor.userId,prepared.scope);
      const result = prepared?.kind==='replay' ? prepared.result : await transaction(async tx => {
        const checked = await prepare(tx);
        if(checked.kind==='replay') return checked.result;
        const {task,q,failed,c}=checked;
        // Transient answered state reuses the existing dispatch and retry transaction.
        // On any admission/custody failure this entire transition rolls back.
        await tx.query("UPDATE factory_questions SET status='answered' WHERE id=$1",[q.id]);
        const next = task.stage === 'execute'
          ? await store.retryQuestion(actor.userId, binding(task), factoryEventId('question-recover-attempt', input.requestId),
            'The owner requested recovery of the failed original-session continuation.', q.id, tx)
          : await store.apply(actor.userId, binding(task), factoryEventId('question-recover-attempt', input.requestId),
            { action: 'retry', reason: 'The owner requested recovery of the failed original-session continuation.' }, tx);
        const followUp=checked.undeliveredAnswer
          ? `${checked.undeliveredAnswer}\n\nRecover the original task after its continuation failed before starting. The accepted answer above has not yet reached the original session. Preserve all existing constraints, inspect the actual current repository state, and do not repeat completed external writes or publication.`
          : 'Recover the failed continuation of the original task. Preserve all existing constraints. Freshly inspect the retained artifact and actual current repository state before continuing; record these current observations for independent review and verification. Keep completed side effects, and do not repeat the original answer or completed external writes or publication. The answer is already in the original session history. This message only requests explicit recovery of that task and grants no new permission.';
        const queued=await dispatch(actor.userId,{binding:binding(next.task),agentId:failed.agentId,deviceRepoId:failed.deviceRepoId,note:followUp},tx,q.originRunId,failed.id);
        const {rows:[run]}=await tx.query('SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE',[queued.runId,actor.userId]);
        if(!run || run.status!=='queued' || run.stopRequestedAt || ['deviceId','deviceRepoId','agentId','baseBranch'].some(k=>run[k]!==failed[k]) ||
          run.agentDefinition?.definitionDigest!==failed.agentDefinition.definitionDigest) fail('factoryQuestionContinuationUnavailable');
        const continuationFollowUp = await appendFactoryCheckContinuationContext(tx, queued.task, run.id, followUp);
        await tx.query('UPDATE agent_runs SET "continuesRunId"=$2,"questionContinuation"=$3 WHERE id=$1',[run.id,failed.id,JSON.stringify({...c,followUp:continuationFollowUp})]);
        await tx.query(`UPDATE factory_questions SET status='resuming',"continuationRunId"=$2,revision=revision+1,"updatedAt"=now() WHERE id=$1`,[q.id,run.id]);
        await skills?.continueQuestion(actor.userId,run.id,tx);
        const recovered={questionId:q.id,continuationRunId:run.id,task:queued.task,replayed:false,historyRunId:failed.id,originRunId:q.originRunId,originSessionId:q.originSessionId};
        await tx.query('INSERT INTO factory_events ("taskId","eventId",request,result) VALUES ($1,$2,$3,$4)',[task.id,eventId,JSON.stringify(request),JSON.stringify(recovered)]);
        return recovered;
      });
      try { await afterContinuation?.(actor.userId,result); }
      catch { console.error(JSON.stringify({msg:'factory_question_wake_deferred',runId:result.continuationRunId})); }
      return result;
    },
    async claimContinuation(
      userId: string,
      deviceId: string,
      runId: string,
      leaseExpiresAt: string,
      existingOrClaim?: PoolClient | ((tx:PoolClient)=>Promise<void>),
    ) {
      const existing = typeof existingOrClaim === "function" ? undefined : existingOrClaim;
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
          `SELECT r.*,a."runId" AS "boundRunId",origin."deviceId" AS "originDeviceId",origin."sessionId" AS "originSessionId",origin."agentId" AS "originAgentId",origin."deviceRepoId" AS "originRepoId",d.enabled,d."lastSeenAt",d.harnesses,d.kind AS "deviceKind",ag.harness,ag."deviceId" AS "agentDeviceId" FROM agent_runs r JOIN factory_attempts a ON a.id=$3 AND a."taskId"=$4 JOIN agent_runs origin ON origin.id=$5 AND origin."userId"=$2 AND origin."issueId"=$6 JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=$2 JOIN agents ag ON ag.id=r."agentId" AND ag."userId"=$2 JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=$2 AND repo."deviceId"=d.id WHERE r.id=$1 AND r."userId"=$2 AND r."issueId"=$6 FOR UPDATE OF r FOR SHARE OF d,ag,repo`,
          [runId, userId, task.attemptId, task.id, q.originRunId, q.issueId],
        );
        // Match the execution run before acquiring placement locks, as runtime
        // maintenance does (run -> machine). A cloud relocation keeps its
        // frozen configuration identity on the original parent computer.
        if (run && run.agentDeviceId !== run.deviceId) {
          if (run.deviceKind !== 'cloud') fail("factoryQuestionContinuationUnavailable");
          const placement = await tx.query(`SELECT 1 FROM computer_run_bindings b JOIN thread_machines m
            ON m."runId"=b."runId" AND m."ownerId"=b."ownerId" AND m."workspaceId"=b."workspaceId" AND m."botId"=b."botId"
            WHERE b."runId"=$1 AND b."ownerId"=$2 AND m."issueId"=$3 AND m."deviceId"=$4 AND m."repoId"=$5
              AND m.state IN ('starting','running') FOR SHARE OF b,m`,[runId,userId,q.issueId,run.deviceId,run.deviceRepoId]);
          if (!placement.rowCount) fail("factoryQuestionContinuationUnavailable");
        }
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
          !await deviceIsOnline({ id: run.deviceId, lastSeenAt: run.lastSeenAt }) ||
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
        let historyRunId = q.originRunId;
        const {rows:[recovery]}=await tx.query(`SELECT e.request,e.result FROM factory_events e
          WHERE e."taskId"=$1 AND e.request->>'kind'='question_recover'
            AND e.result->>'continuationRunId'=$2`,[task.id,run.id]);
        if (run.id !== q.result?.continuationRunId || recovery || (run.continuesRunId && run.continuesRunId !== q.originRunId)) {
          if(!recovery || recovery.request.userId!==userId || recovery.result.questionId!==q.id ||
            recovery.result.historyRunId!==run.continuesRunId || recovery.request.input.expectedFailedRunId!==run.continuesRunId ||
            recovery.result.originRunId!==q.originRunId || recovery.result.originSessionId!==q.originSessionId ||
            recovery.result.task.attemptId!==task.attemptId || recovery.result.task.candidateId!==task.candidateId)
            fail('factoryQuestionContinuationUnavailable');
          const {rows:[source]}=await tx.query('SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR SHARE',[run.continuesRunId,userId,q.issueId]);
          const link=source?.questionContinuation;
          const unclaimed = source?.sessionId === null ? await unclaimedPlanQuestionContinuation(tx,task,source.id) : null;
          if(!source || source.status!=='failed' || source.stopRequestedAt || (source.sessionId!==q.originSessionId && !unclaimed) ||
            ['deviceId','deviceRepoId','agentId','baseBranch'].some(k=>source[k]!==run[k]) ||
            source.agentDefinition?.definitionDigest!==run.agentDefinition?.definitionDigest ||
            questionFingerprint(source.agentDefinition?.subscription ?? null)!==questionFingerprint(run.agentDefinition?.subscription ?? null) ||
            link?.questionId!==q.id || link.originRunId!==q.originRunId || link.originSessionId!==q.originSessionId || link.requireSessionResume!==true)
            fail('factoryQuestionContinuationUnavailable');
          const {rows:[scope]}=await tx.query(`SELECT 1 FROM computer_run_bindings old
            JOIN computer_run_bindings current ON current."runId"=$2 AND current."ownerId"=old."ownerId"
              AND current."workspaceId"=old."workspaceId" AND current."botId"=old."botId"
            WHERE old."runId"=$1 AND old."ownerId"=$3`,[source.id,run.id,userId]);
          if(run.deviceKind==='cloud' && !scope) fail('factoryQuestionContinuationUnavailable');
          if (unclaimed) {
            const edge = await questionPlanContinuation(tx,task,task.attemptId);
            if (!edge || edge.sourceRunId !== source.id || edge.questionId !== q.id ||
              edge.continuationRunId !== run.id || edge.historyRunId !== unclaimed.historyRunId)
              fail('factoryQuestionContinuationUnavailable');
            historyRunId=edge.historyRunId;
          } else historyRunId=source.id;
        }
        const check =
          run.kind === "acceptance"
            ? validateCheck ? await validateCheck(tx, task, runId) : fail("factoryDispatchAdapterRequired")
            : {};
        if (!existing) {
          await tx.query('UPDATE agent_runs SET status=\'preparing\',"startedAt"=now(),"leaseExpiresAt"=$2,"updatedAt"=now() WHERE id=$1',[runId,leaseExpiresAt]);
          advanceTaskAfterRunStart(tx,runId);
          await runListChanged(tx,runId);
          await runChanged(tx,runId);
          if (typeof existingOrClaim === "function") await existingOrClaim(tx);
        }
        return {
          ...check,
          continuesRunId: historyRunId,
          resumeSessionId: q.originSessionId,
          followUp: c.followUp as string,
          requireSessionResume: true as const,
          questionId: q.id,
        };
      }, existing);
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
        if (questionClosed(q.status)) return currentView(tx,task,q,false);
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
          run?.sessionId === q.originSessionId &&
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
            : !run
              ? "Original session continuation is unavailable; explicit recovery required"
              : "Original session continuation failed; explicit recovery required";
        const {
          rows: [updated],
        } = await tx.query<FactoryQuestion>(
          'UPDATE factory_questions SET status=$2,reason=$3,revision=revision+1,"updatedAt"=now() WHERE id=$1 RETURNING *',
          [q.id, status, reason],
        );
        await factoryChanged(tx, task);
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
              factoryEventId("question-resume-failed", `${q.id}:${runId}`),
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
