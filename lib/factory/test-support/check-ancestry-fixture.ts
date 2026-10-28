import type { FactoryCheckTaskIdentity } from "../check-independence";

// Explicit synthetic row graph shared only by pure and isolated PG/HTTP tests.
export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const session = "synthetic-shared-check-session";
const base = {
  id: uuid(1),
  userId: "fixture-owner",
  issueId: uuid(2),
  sourceEventId: uuid(3),
  stage: "verify",
  status: "running",
  candidateId: uuid(4),
};
export function fixture(depth = 2, failed = false, stage = "verify") {
  const task: FactoryCheckTaskIdentity = {
    ...base,
    stage,
    attemptId: uuid(10 + depth),
  };
  const attempts = Array.from({ length: depth + 1 }, (_, i) => ({
    id: uuid(10 + i),
    taskId: task.id,
    stage: task.stage,
    candidateId: task.candidateId,
    ordinal: i + 1,
    position: i + 1,
    status: i === depth ? "running" : "waiting",
    runId: uuid(20 + i),
    sessionId: session,
    run: {
      id: uuid(20 + i),
      userId: task.userId,
      issueId: task.issueId,
      sessionId: session,
      kind: "acceptance",
      retryOf: null as string | null,
      status: i === depth ? (failed ? "failed" : "succeeded") : "stopped",
      stopReason: i === depth ? "submitted" : "asked_human",
      stopRequestedAt: null as string | null,
      agentId: uuid(5),
      deviceId: uuid(6),
      deviceRepoId: uuid(7),
      baseBranch: "a".repeat(40),
      questionContinuation: i
        ? {
            questionId: uuid(30 + i),
            originRunId: uuid(19 + i),
            originSessionId: session,
            requireSessionResume: true,
          }
        : null,
    },
  }));
  const questions = Array.from({ length: depth }, (_, j) => {
    const i = j + 1,
      originRevision = 1 + j * 3;
    return {
      id: uuid(30 + i),
      userId: task.userId,
      issueId: task.issueId,
      taskId: task.id,
      attemptId: uuid(9 + i),
      candidateId: task.candidateId,
      stage: task.stage,
      originRunId: uuid(19 + i),
      originSessionId: session,
      originRevision,
      waitingBinding: {
        taskId: task.id,
        issueId: task.issueId,
        attemptId: uuid(9 + i),
        candidateId: task.candidateId,
        revision: originRevision + 1,
      },
      status: "resolved",
      answerId: uuid(40 + i),
      answerSource: "orchestrator",
      answerFingerprint: `synthetic-answer-${i}`,
      answeredAt: new Date(0),
      continuationRunId: uuid(20 + i),
      result: {
        questionId: uuid(30 + i),
        continuationRunId: uuid(20 + i),
        task: {
          ...task,
          attemptId: uuid(10 + i),
          revision: originRevision + 3,
        },
      },
    };
  });
  return { task, attempts, questions, runId: uuid(20 + depth) };
}
