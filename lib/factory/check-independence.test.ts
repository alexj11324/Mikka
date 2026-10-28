import assert from "node:assert/strict";
import test from "node:test";
import {
  FACTORY_CHECK_ANCESTRY_CONTRACT_VERSION,
  factoryCheckIndependent,
  type FactoryCheckTaskIdentity,
} from "./check-independence";

// Pure, explicit persisted-row fixtures: these do not execute SQL or prove a
// provider run. Integration must use the actual #192 tables/transaction fences.
const uuid = (n: number) =>
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
function fixture(depth = 2, failed = false) {
  const task: FactoryCheckTaskIdentity = {
    ...base,
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
type Fixture = ReturnType<typeof fixture>;
async function independent(f: Fixture) {
  const before = structuredClone(f);
  let reads = 0;
  const tx = {
    async query(sql: string, values: unknown[]) {
      assert.match(sql, /^SELECT /);
      assert.ok(++reads <= f.attempts.length + 2, "traversal must terminate");
      if (sql.includes("FROM factory_attempts a")) {
        assert.deepEqual(values, [f.task.id]);
        return { rows: f.attempts.filter((a) => a.taskId === values[0]) };
      }
      assert.match(sql, /FROM factory_questions WHERE "continuationRunId"=\$1/);
      return {
        rows: f.questions.filter((q) => q.continuationRunId === values[0]),
      };
    },
  } as unknown as Parameters<typeof factoryCheckIndependent>[0];
  const result = await factoryCheckIndependent(tx, f.task, f.runId);
  assert.deepEqual(f, before, "predicate must not mutate Factory state");
  return result;
}

test("v1 exports an actual read-only predicate; both terminal outcomes use identical ancestry rules", async (t) => {
  assert.equal(FACTORY_CHECK_ANCESTRY_CONTRACT_VERSION, 1);
  for (const stage of ["review", "verify"])
    for (const failed of [false, true]) {
      await t.test(
        `${stage} ${failed ? "failure" : "pass"} supports zero, one and multiple questions`,
        async () => {
          for (const depth of [0, 1, 2, 8]) {
            const f = fixture(depth, failed);
            f.task.stage = stage;
            for (const a of f.attempts) a.stage = stage;
            for (const q of f.questions) {
              q.stage = stage;
              q.result.task.stage = stage;
            }
            assert.equal(await independent(f), true);
          }
        },
      );
    }
});

const corruptions: Record<string, (f: Fixture) => void> = {
  "owner mismatch on current run": (f) => {
    f.attempts.at(-1)!.run.userId = "foreign";
  },
  "owner mismatch on origin": (f) => {
    f.attempts[0].run.userId = "foreign";
  },
  "question owner mismatch": (f) => {
    f.questions[0].userId = "foreign";
  },
  "issue mismatch": (f) => {
    f.questions[0].issueId = uuid(90);
  },
  "task mismatch": (f) => {
    f.questions[0].taskId = uuid(90);
  },
  "candidate mismatch": (f) => {
    f.questions[0].candidateId = uuid(90);
  },
  "phase mismatch": (f) => {
    f.attempts[0].stage = "review";
  },
  "question phase mismatch": (f) => {
    f.questions[0].stage = "review";
  },
  "origin attempt mismatch": (f) => {
    f.questions[0].attemptId = uuid(90);
  },
  "waiting attempt mismatch": (f) => {
    f.questions[0].waitingBinding.attemptId = uuid(90);
  },
  "waiting revision mismatch": (f) => {
    f.questions[0].waitingBinding.revision++;
  },
  "result revision mismatch": (f) => {
    f.questions[0].result.task.revision++;
  },
  "result attempt mismatch": (f) => {
    f.questions[0].result.task.attemptId = uuid(90);
  },
  "result source mismatch": (f) => {
    f.questions[0].result.task.sourceEventId = uuid(90);
  },
  "origin session mismatch": (f) => {
    f.questions[0].originSessionId = "foreign-session";
  },
  "stored attempt session mismatch": (f) => {
    f.attempts[0].sessionId = "foreign-session";
  },
  "actual run session mismatch": (f) => {
    f.attempts[0].run.sessionId = "foreign-session";
  },
  "origin run mismatch": (f) => {
    f.questions[0].originRunId = uuid(90);
  },
  "continuation result mismatch": (f) => {
    f.questions[0].result.continuationRunId = uuid(90);
  },
  "durable continuation link missing": (f) => {
    f.questions[0].continuationRunId = uuid(90);
  },
  "run continuation metadata missing": (f) => {
    f.attempts.at(-1)!.run.questionContinuation = null;
  },
  "metadata question mismatch": (f) => {
    f.attempts.at(-1)!.run.questionContinuation!.questionId = uuid(90);
  },
  "fresh-session fallback allowed": (f) => {
    f.attempts.at(-1)!.run.questionContinuation!.requireSessionResume = false;
  },
  "generic retry child": (f) => {
    f.attempts.at(-1)!.run.retryOf = f.attempts[0].runId;
  },
  "cancelled question": (f) => {
    f.questions[0].status = "cancelled";
  },
  "unresolved question": (f) => {
    f.questions[0].status = "resuming";
  },
  "missing accepted answer": (f) => {
    f.questions[0].answerFingerprint = "";
  },
  "origin stop request": (f) => {
    f.attempts[0].run.stopRequestedAt = new Date().toISOString();
  },
  "revoked original attempt": (f) => {
    f.attempts[0].status = "revoked";
  },
  "cancelled task": (f) => {
    f.task.status = "cancelled";
  },
  "revoked task": (f) => {
    f.task.status = "revoked";
  },
  "agent changed": (f) => {
    f.attempts[0].run.agentId = uuid(90);
  },
  "device changed": (f) => {
    f.attempts[0].run.deviceId = uuid(90);
  },
  "repository changed": (f) => {
    f.attempts[0].run.deviceRepoId = uuid(90);
  },
  "fixed SHA changed": (f) => {
    f.attempts[0].run.baseBranch = "b".repeat(40);
  },
  "nonconsecutive attempt position": (f) => {
    f.attempts[0].position += 5;
  },
  "nonconsecutive phase ordinal": (f) => {
    f.attempts[0].ordinal += 5;
  },
  "ancestor cycle": (f) => {
    f.questions.at(-1)!.attemptId = f.task.attemptId;
  },
  "current run not bound": (f) => {
    f.runId = uuid(90);
  },
};
test("v1 denies corrupt or unrelated continuation ancestry for success AND failure", async (t) => {
  for (const [name, mutate] of Object.entries(corruptions))
    for (const failed of [false, true]) {
      await t.test(`${name} (${failed ? "failure" : "pass"})`, async () => {
        const f = fixture(2, failed);
        mutate(f);
        assert.equal(await independent(f), false);
      });
    }
});
test("ordinary same-phase retry or cross-phase reuse never acquires a question exemption", async () => {
  const f = fixture(0);
  f.attempts.push({
    ...structuredClone(f.attempts[0]),
    id: uuid(70),
    runId: uuid(71),
    status: "failed",
  });
  assert.equal(await independent(f), false);
  f.attempts.at(-1)!.stage = "execute";
  assert.equal(await independent(f), false);
});
test("v1 does not grant monitor/approval/publish or permission/check-result authority", async () => {
  for (const stage of ["execute", "monitor", "approval", "publish"]) {
    const f = fixture(0);
    f.task.stage = stage;
    f.attempts[0].stage = stage;
    assert.equal(await independent(f), false);
  }
  assert.equal(
    await independent(fixture(2, true)),
    true,
    "independent failed evidence is not a pass verdict",
  );
});
