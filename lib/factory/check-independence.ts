import type { PoolClient } from "pg";
import { questionFingerprint } from "./questions/contract";

/** Structural projection of the existing Factory rows, not another stage/state source.
 * Full #192 task types are assignable without importing an unmerged foundation. */
export interface FactoryCheckTaskIdentity {
  id: string;
  userId: string;
  issueId: string;
  sourceEventId: string;
  stage: string;
  status: string;
  attemptId: string;
  candidateId: string | null;
}

export const FACTORY_CHECK_ANCESTRY_CONTRACT_VERSION = 2 as const;

type FactoryAttempt = {
  id: string;
  taskId: string;
  stage: string;
  ordinal: number;
  position: number;
  status: string;
  candidateId: string | null;
  runId: string | null;
  sessionId: string | null;
};
type FactoryQuestion = {
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
  waitingBinding: {
    taskId: string;
    issueId: string;
    attemptId: string;
    candidateId: string | null;
    revision: number;
  };
  status: string;
  answerId: string | null;
  answerSource: string | null;
  answerFingerprint: string | null;
  result: {
    questionId: string;
    continuationRunId: string;
    task: FactoryCheckTaskIdentity & { revision: number };
  } | null;
};

type CheckRun = {
  id: string;
  userId: string;
  issueId: string;
  sessionId: string | null;
  kind: string;
  retryOf: string | null;
  status: string;
  stopReason: string | null;
  stopRequestedAt: string | null;
  agentId: string | null;
  deviceId: string | null;
  deviceRepoId: string | null;
  baseBranch: string;
  continuesRunId: string | null;
  agentDefinition: {
    definitionDigest?: string;
    subscription?: unknown;
  } | null;
  questionContinuation: {
    questionId: string;
    originRunId: string;
    originSessionId: string;
    requireSessionResume: boolean;
  } | null;
};
type AttemptRun = FactoryAttempt & { run: CheckRun | null };

/** A check may resume its own question, but must stay independent of every
 * other phase/session. The caller holds the authorized task lock. No retryOf
 * edge or same-stage coincidence establishes a trusted question ancestor.
 *
 * Version 2 supports review/verify/monitor with the same strict ancestry fences. true proves session independence/ancestry,
 * not a passed check, current permission, a daemon receipt or approval of a monitor result.
 * The caller must hold the authorized task lock and validate its frozen check
 * assignment; pass and failure consumers invoke this same read-only predicate. */
export async function factoryCheckIndependent(
  tx: Pick<PoolClient, "query">,
  task: FactoryCheckTaskIdentity,
  runId: string,
): Promise<boolean> {
  const { rows } = await tx.query<AttemptRun>(
    `SELECT a.*,to_jsonb(r) AS run FROM factory_attempts a
     LEFT JOIN agent_runs r ON r.id=a."runId" WHERE a."taskId"=$1`,
    [task.id],
  );
  const current = rows.find((a) => a.id === task.attemptId);
  const session = current?.run?.sessionId;
  if (
    task.status !== "running" ||
    !["review", "verify", "monitor"].includes(task.stage) ||
    !task.candidateId ||
    !current ||
    current.runId !== runId ||
    current.status !== "running" ||
    !session
  )
    return false;
  let child: AttemptRun = current;
  const valid = (a: AttemptRun) =>
    a.taskId === task.id &&
    a.stage === task.stage &&
    a.candidateId === task.candidateId &&
    a.run?.id === a.runId &&
    a.run?.userId === task.userId &&
    a.run?.issueId === task.issueId &&
    a.run?.kind === "acceptance" &&
    !a.run?.retryOf &&
    !a.run?.stopRequestedAt &&
    a.run?.sessionId === session &&
    (!a.sessionId || a.sessionId === session);
  const ancestors = new Set<string>();
  const visited = new Set([child.id]);
  while (true) {
    const run: CheckRun = child.run!;
    const link = run.questionContinuation;
    // Look up by the persisted continuation binding, not an untrusted UUID
    // supplied in run metadata. Missing/corrupt metadata fails closed.
    // The immutable first-answer result and each question_recover receipt bind
    // earlier continuation runs to this same question; only the mutable
    // continuationRunId column tracks the latest one.
    const {
      rows: [q],
    } = await tx.query<FactoryQuestion & { answeredAt: Date | null }>(
      `SELECT * FROM factory_questions WHERE "continuationRunId"=$1
        OR result->>'continuationRunId'=$1::text
        OR EXISTS(SELECT 1 FROM factory_events e
          WHERE e."taskId"=factory_questions."taskId"
            AND e.request->>'kind'='question_recover'
            AND e.result->>'questionId'=factory_questions.id::text
            AND e.result->>'continuationRunId'=$1::text)`,
      [run.id],
    );
    if (!link) {
      if (q || (ancestors.size > 0 && !valid(child))) return false;
      break;
    }
    if (!valid(child)) return false;
    const waiting = q?.waitingBinding;
    const result = q?.result;
    if (
      !q ||
      q.status !== "resolved" ||
      q.userId !== task.userId ||
      q.issueId !== task.issueId ||
      q.taskId !== task.id ||
      q.stage !== task.stage ||
      q.candidateId !== task.candidateId ||
      !q.answerId ||
      !q.answerSource ||
      !q.answerFingerprint ||
      !q.answeredAt ||
      link.questionId !== q.id ||
      link.originRunId !== q.originRunId ||
      link.originSessionId !== session ||
      link.requireSessionResume !== true ||
      q.originSessionId !== session ||
      waiting?.taskId !== task.id ||
      waiting.issueId !== task.issueId ||
      waiting.candidateId !== task.candidateId ||
      waiting.revision !== q.originRevision + 1 ||
      result?.questionId !== q.id
    )
      return false;
    if (result.continuationRunId === run.id) {
      // The first answer's own continuation resumes the waiting attempt
      // directly; its frozen shape stays exactly as before.
      const parent = rows.find((a) => a.id === q.attemptId);
      const origin = parent?.run;
      const resumed = result.task;
      if (
        waiting.attemptId !== parent?.id ||
        resumed?.id !== task.id ||
        resumed.userId !== task.userId ||
        resumed.issueId !== task.issueId ||
        resumed.sourceEventId !== task.sourceEventId ||
        resumed.stage !== task.stage ||
        resumed.candidateId !== task.candidateId ||
        resumed.attemptId !== child.id ||
        resumed.status !== "running" ||
        resumed.revision !== waiting.revision + 2 ||
        !parent ||
        visited.has(parent.id) ||
        parent.status !== "waiting" ||
        parent.sessionId !== session ||
        parent.position + 1 !== child.position ||
        parent.ordinal + 1 !== child.ordinal ||
        !origin ||
        origin.id !== q.originRunId ||
        origin.status !== "stopped" ||
        !["asked_human", "blocked"].includes(origin.stopReason ?? "") ||
        !origin.agentId ||
        origin.agentId !== run.agentId ||
        !origin.deviceId ||
        origin.deviceId !== run.deviceId ||
        !origin.deviceRepoId ||
        origin.deviceRepoId !== run.deviceRepoId ||
        origin.baseBranch !== run.baseBranch
      )
        return false;
      ancestors.add(parent.id);
      visited.add(parent.id);
      child = parent;
      continue;
    }
    // An owner-requested recovery of a failed continuation: the immutable
    // question_recover receipt binds this run to its failed predecessor, which
    // must be the immediately preceding same-stage attempt. The first answer,
    // its result and the failed history stay immutable; the walk then follows
    // the failed predecessor until the first answer's own continuation.
    const {
      rows: [receipt],
    } = await tx.query<{
      request: { userId?: string; input?: { expectedFailedRunId?: string } };
      result: {
        questionId?: string;
        continuationRunId?: string;
        historyRunId?: string;
        originRunId?: string;
        originSessionId?: string;
        replayed?: boolean;
        task?: { id?: string; attemptId?: string; candidateId?: string | null };
      };
    }>(
      `SELECT e.request,e.result FROM factory_events e
        WHERE e."taskId"=$1 AND e.request->>'kind'='question_recover'
          AND e.result->>'continuationRunId'=$2`,
      [task.id, run.id],
    );
    const failedId = receipt?.result?.historyRunId;
    const parent = rows.find((a) => a.runId === failedId);
    const failed = parent?.run;
    const failedLink = failed?.questionContinuation;
    if (
      !receipt ||
      receipt.request?.userId !== task.userId ||
      receipt.request?.input?.expectedFailedRunId !== run.continuesRunId ||
      receipt.result?.questionId !== q.id ||
      receipt.result?.continuationRunId !== run.id ||
      receipt.result?.replayed !== false ||
      !failedId ||
      failedId !== run.continuesRunId ||
      receipt.result?.originRunId !== q.originRunId ||
      receipt.result?.originSessionId !== q.originSessionId ||
      receipt.result?.task?.id !== task.id ||
      receipt.result?.task?.attemptId !== child.id ||
      receipt.result?.task?.candidateId !== task.candidateId ||
      !parent ||
      visited.has(parent.id) ||
      !valid(parent) ||
      parent.status !== "blocked" ||
      parent.position + 1 !== child.position ||
      parent.ordinal + 1 !== child.ordinal ||
      !failed ||
      failed.status !== "failed" ||
      failed.stopRequestedAt ||
      failed.sessionId !== session ||
      failedLink?.questionId !== q.id ||
      failedLink.originRunId !== q.originRunId ||
      failedLink.originSessionId !== session ||
      failedLink.requireSessionResume !== true ||
      !failed.agentId ||
      failed.agentId !== run.agentId ||
      !failed.deviceId ||
      failed.deviceId !== run.deviceId ||
      !failed.deviceRepoId ||
      failed.deviceRepoId !== run.deviceRepoId ||
      failed.baseBranch !== run.baseBranch ||
      !failed.agentDefinition?.definitionDigest ||
      failed.agentDefinition.definitionDigest !==
        run.agentDefinition?.definitionDigest ||
      questionFingerprint(failed.agentDefinition.subscription ?? null) !==
        questionFingerprint(run.agentDefinition?.subscription ?? null)
    )
      return false;
    ancestors.add(parent.id);
    visited.add(parent.id);
    child = parent;
  }
  // Same-run reuse is never allowed. Only exact ancestors may share a session;
  // Other phases and unrelated retries retain distinct identities.
  return rows.every(
    (a) =>
      a.id === task.attemptId ||
      (a.runId !== runId &&
        ((a.sessionId !== session && a.run?.sessionId !== session) ||
          ancestors.has(a.id))),
  );
}
