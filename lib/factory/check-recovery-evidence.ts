import { questionExecutionContinuation } from './questions/execution-continuation';
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
    (check?.requestEpoch != null && check.requestEpoch !== task.sourceEventId) ||
    (attempt.output?.requestEpoch != null && attempt.output.requestEpoch !== task.sourceEventId) ||
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
  if (choice === "repair_code") await checkFactoryRepairBudget(tx, task);
}
/** At most maxFixAttempts new execute attempts beyond the first per
 * authenticated request. Host-verified question resume/recovery segments are
 * one execution; unreceipted legacy attempts keep counting conservatively. */
export async function checkFactoryRepairBudget(tx: PoolClient, task: Pick<FactoryTask, "id">) {
  const { rows } = await tx.query<Pick<FactoryTask, 'id' | 'userId' | 'issueId' | 'sourceEventId' | 'botId'> & { attemptId: string; continuation: boolean }>(
    `SELECT t.id,t."userId",t."issueId",t."sourceEventId",t."botId",a.id AS "attemptId",r."questionContinuation" IS NOT NULL AS continuation
      FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" LEFT JOIN agent_runs r ON r.id=a."runId"
      WHERE a."taskId"=$1 AND a.stage='execute' AND COALESCE(a.output->>'requestEpoch',t."sourceEventId"::text)=t."sourceEventId"::text
        AND NOT (COALESCE(a.output->>'recovery','')='provider_failure' AND EXISTS (
          SELECT 1 FROM agent_runs failed WHERE failed.id=a."runId" AND failed."userId"=t."userId" AND failed."issueId"=t."issueId"
            AND failed.status='failed' AND failed."stopReason"='provider_failure' AND failed."stopRequestedAt" IS NULL))`, [task.id]);
  const parents = new Map(rows.map(row => [row.attemptId, row.attemptId]));
  const root = (id: string): string => {
    const parent = parents.get(id)!;
    if (parent === id) return id;
    const result = root(parent);
    parents.set(id, result);
    return result;
  };
  for (const row of rows) {
    if (!row.continuation) continue;
    const edge = await questionExecutionContinuation(tx, row, row.attemptId);
    if (!edge) continue;
    // Legacy recovery binds the original question, failed direct predecessor
    // and recovered child. This union affects budget only, never command reads.
    const group = [edge.questionOriginAttemptId, edge.originAttemptId, edge.continuationAttemptId];
    if (group.some(id => !parents.has(id))) continue;
    const first = root(group[0]);
    for (const id of group.slice(1)) parents.set(root(id), first);
  }
  const executions = new Set([...parents.keys()].map(root)).size;
  if (executions > orchestratorSettings({}).maxFixAttempts)
    throw new FactoryError("factoryRecoveryBudgetExceeded");
}
