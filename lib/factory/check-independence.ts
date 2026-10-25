import type { PoolClient } from "pg";
import type { FactoryAttempt, FactoryTask } from "./store";
import type { FactoryQuestion } from "./questions/store";

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
 * edge or same-stage coincidence establishes a trusted question ancestor. */
export async function factoryCheckIndependent(
  tx: Pick<PoolClient, "query">,
  task: FactoryTask,
  runId: string,
) {
  const { rows } = await tx.query<AttemptRun>(
    `SELECT a.*,to_jsonb(r) AS run FROM factory_attempts a
     LEFT JOIN agent_runs r ON r.id=a."runId" WHERE a."taskId"=$1`,
    [task.id],
  );
  let child = rows.find((a) => a.id === task.attemptId);
  const session = child?.run?.sessionId;
  if (
    task.status !== "running" ||
    !["review", "verify"].includes(task.stage) ||
    !task.candidateId ||
    !child ||
    child.runId !== runId ||
    child.status !== "running" ||
    !session
  )
    return false;
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
    if (!valid(child)) return false;
    const run = child.run!;
    const link = run.questionContinuation;
    // Look up by the persisted continuation binding, not an untrusted UUID
    // supplied in run metadata. Missing/corrupt metadata fails closed.
    const {
      rows: [q],
    } = await tx.query<FactoryQuestion & { answeredAt: Date | null }>(
      'SELECT * FROM factory_questions WHERE "continuationRunId"=$1',
      [run.id],
    );
    if (!link) {
      if (q) return false;
      break;
    }
    const parent = rows.find((a) => a.id === q?.attemptId);
    const origin = parent?.run;
    const waiting = q?.waitingBinding;
    const result = q?.result;
    const resumed = result?.task;
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
      waiting.attemptId !== parent?.id ||
      waiting.candidateId !== task.candidateId ||
      waiting.revision !== q.originRevision + 1 ||
      result?.questionId !== q.id ||
      result.continuationRunId !== run.id ||
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
  }
  // Same-run reuse is never allowed. Only exact ancestors may share a session;
  // execute/review/verify and unrelated retries retain distinct identities.
  return rows.every(
    (a) =>
      a.id === task.attemptId ||
      (a.runId !== runId &&
        ((a.sessionId !== session && a.run?.sessionId !== session) ||
          ancestors.has(a.id))),
  );
}
