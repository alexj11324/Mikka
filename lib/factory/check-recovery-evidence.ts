import type { PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { orchestratorSettings } from "@mikka/protocol/orchestrator";
import { FactoryError } from "./contract";
import { factoryEventId } from "./event-id";
import type { FactoryTask } from "./store";
export function recoveryFail(code: string): never {
  throw new FactoryError(code);
}
const fail = recoveryFail;
export async function readFactoryCheckFailure(
  tx: PoolClient,
  task: FactoryTask,
) {
  if (
    !["failed", "blocked"].includes(task.status) ||
    !["review", "verify"].includes(task.stage) ||
    !task.candidateId
  )
    throw new FactoryError("factoryTransition");
  const {
    rows: [attempt],
  } = await tx.query(
    'SELECT * FROM factory_attempts WHERE id=$1 AND "taskId"=$2 FOR UPDATE',
    [task.attemptId, task.id],
  );
  const {
    rows: [finish],
  } = await tx.query(
    'SELECT result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2',
    [task.id, factoryEventId("check-completion", attempt?.runId ?? "")],
  );
  const {
    rows: [run],
  } = await tx.query(
    'SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR UPDATE',
    [attempt?.runId, task.userId, task.issueId],
  );
  const {
    rows: [candidate],
  } = await tx.query(
    'SELECT * FROM factory_candidates WHERE id=$1 AND "taskId"=$2',
    [task.candidateId, task.id],
  );
  const check = attempt?.output?.check,
    report = run?.report,
    receipt = finish?.result?.task;
  // Mechanical provenance only: the recorded failed finish already passed the
  // shared strict ancestry predicate. Do not reinterpret its failure's cause.
  if (
    !attempt ||
    attempt.status !== task.status ||
    attempt.stage !== task.stage ||
    attempt.candidateId !== task.candidateId ||
    !run ||
    !["succeeded", "failed", "stopped"].includes(run.status) ||
    run.stopRequestedAt ||
    ["cancelled", "revoked"].includes(run.stopReason) ||
    run.retryOf ||
    run.botId !== task.botId ||
    !run.sessionId ||
    run.sessionId !== attempt.sessionId ||
    !candidate ||
    receipt?.id !== task.id ||
    receipt.attemptId !== attempt.id ||
    receipt.candidateId !== candidate.id ||
    receipt.stage !== task.stage ||
    receipt.status !== task.status ||
    attempt.output?.completion?.trustedFailureProvenance !== true ||
    attempt.output.completion.runId !== run.id ||
    check?.stage !== task.stage ||
    check.candidateId !== candidate.id ||
    run.kind !== "acceptance" ||
    run.baseBranch !== candidate.sha ||
    check.sha !== candidate.sha ||
    check.repository !== candidate.repository ||
    check.environment !== candidate.environment ||
    check.deviceRepoId !== run.deviceRepoId ||
    !check.command ||
    report?.check?.sha !== candidate.sha ||
    report.check.readOnly !== true ||
    report.verify?.command !== check.command ||
    !(
      Number.isFinite(report.verify?.exitCode) ||
      report.verify?.exitCode === null
    ) ||
    !isDeepStrictEqual(
      attempt.output,
      finish.result.attempts.find((a: { id: string }) => a.id === attempt.id)
        ?.output,
    ) ||
    !isDeepStrictEqual(report.check, attempt.output.completion.check) ||
    !isDeepStrictEqual(report.verify, attempt.output.completion.verify) ||
    run.stopReason !== attempt.output.completion.stopReason ||
    run.error !== attempt.output.completion.error
  )
    fail("factoryCheckBindingMismatch");

  return { task, attempt, run, candidate };
}
export function factoryCheckObservationDigest(
  state: Awaited<ReturnType<typeof readFactoryCheckFailure>>,
) {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object" && !(value instanceof Date))
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(state)))
    .digest("hex");
}
export async function checkFactoryRecoveryBudget(
  tx: PoolClient,
  task: FactoryTask,
  choice?: string,
) {
  const {
    rows: [budget],
  } = await tx.query(
    `SELECT count(*)::int AS count FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='factory_check_recovery' AND request->'input'->'binding'->>'candidateId'=$2`,
    [task.id, task.candidateId],
  );
  if (budget.count >= orchestratorSettings({}).maxFixAttempts)
    throw new FactoryError("factoryRecoveryBudgetExceeded");
  if (choice === "repair_code") {
    const {
      rows: [count],
    } = await tx.query(
      `SELECT count(*)::int AS count FROM factory_attempts WHERE "taskId"=$1 AND stage='execute'`,
      [task.id],
    );
    if (count.count > orchestratorSettings({}).maxFixAttempts)
      throw new FactoryError("factoryRecoveryBudgetExceeded");
  }
}
