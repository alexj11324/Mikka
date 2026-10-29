import type { PoolClient } from "pg";
import type { RunReport } from "@mikka/protocol/run";
import {
  FactoryError,
  type FactoryBinding,
  type FactoryEvidence,
} from "./contract";
import { factoryCheckAssignment, verifierCommandEvidence } from "./checks";
import { factoryCheckIndependent } from "./check-independence";
import { factoryEventId } from "./event-id";
import type { FactoryTask, createFactoryStore } from "./store";

const binding = (t: FactoryTask): FactoryBinding => ({
  taskId: t.id,
  issueId: t.issueId,
  attemptId: t.attemptId,
  revision: t.revision,
  candidateId: t.candidateId,
});

/** Uses the same completion records and transaction as spec/execute reconciliation. */
export async function reconcileFactoryCheck(
  tx: PoolClient,
  store: ReturnType<typeof createFactoryStore>,
  task: FactoryTask,
  input: Record<string, unknown>,
) {
  const { rows: [run] } = await tx.query<{
    id: string;
    sessionId: string | null;
    report: RunReport | null;
    status: string;
    stopReason: string;
    stopRequestedAt: Date | null;
    error: string | null;
    finishedAt: Date | null;
    startedAt: Date | null;
  }> (
    'SELECT r.* FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a.id=$1 AND a."taskId"=$2 AND r.id=$3 AND r."userId"=$4 AND r."issueId"=$5 FOR UPDATE OF r',
    [task.attemptId,task.id,input.id,task.userId,task.issueId],
  );
  if (!run) throw new FactoryError("factoryCheckBindingMismatch");
  if (!["review", "verify"].includes(task.stage))
    throw new FactoryError("factoryCheckBindingMismatch");
  if (
    run.stopRequestedAt ||
    run.stopReason === "cancelled" ||
    run.status === "cancelled"
  ) {
    await store.apply(
      task.userId,
      binding(task),
      factoryEventId("check-cancel", run.id),
      { action: "cancel", reason: "Independent check cancelled" },
      tx,
    );
    return;
  }
  const {
    rows: [candidate],
  } = await tx.query(
    `SELECT * FROM factory_candidates WHERE id=$1 AND "taskId"=$2`,
    [task.candidateId, task.id],
  );
  const evidence: FactoryEvidence[] =
    run.sessionId && run.report && candidate && run.finishedAt && Number.isFinite(new Date(run.finishedAt).getTime())
      ? [
          {
            artifact: `run-report:${run.id}`,
            kind: "report",
            runId: run.id,
            sessionId: run.sessionId,
            candidateId: candidate.id,
            sha: candidate.sha,
            environment: candidate.environment,
            recordedAt: new Date(run.finishedAt!).toISOString(),
          },
        ]
      : [];
  const output = {
    runId: run.id,
    stopReason: run.stopReason,
    error: run.error,
    verify: run.report?.verify,
    check: run.report?.check,
    summary: run.report?.summary?.slice(0, 2000),
    findings: run.report?.criteria
      ?.filter((c) => !c.passed)
      .slice(0, 3)
      .map((c) => ({ ...c, evidence: c.evidence?.slice(0, 8000) })),
    knownIssues: run.report?.knownIssues?.slice(0, 5),
    trustedFailureProvenance: false,
  };
  // Keep the frozen check assignment for gate revalidation and audit.
  const {
    rows: [attempt],
  } = await tx.query(`SELECT output FROM factory_attempts WHERE id=$1`, [
    task.attemptId,
  ]);
  if (
    task.stage === "verify" &&
    evidence.length &&
    attempt?.output?.check?.command
  ) {
    for (const id of await verifierCommandEvidence(
      tx,
      run.id,
      attempt.output.check.command,
      true,
    ))
      evidence.push({
        ...evidence[0],
        artifact: `run-chunk:${id}`,
        kind: "log",
      });
  }
  const completion = { ...attempt?.output, completion: output };
  let status: "passed" | "failed" | "blocked" | "waiting" = "passed";
  let reason =
    "Independent read-only session and real command passed on the fixed candidate";
  if (
    !run.sessionId ||
    !run.startedAt ||
    !run.finishedAt ||
    !Number.isFinite(new Date(run.startedAt).getTime()) ||
    !Number.isFinite(new Date(run.finishedAt).getTime()) ||
    new Date(run.finishedAt).getTime() < new Date(run.startedAt).getTime() ||
    !run.report ||
    !candidate ||
    (run.status === "stopped" && run.stopReason !== "asked_human") ||
    ["blocked", "device_lost", "timeout"].includes(run.stopReason)
  ) {
    status = "blocked";
    reason = `Independent check blocked: ${run.error ?? run.report?.blockedOn ?? run.stopReason ?? "missing session/report/candidate"}`;
  } else if (run.stopReason === "asked_human") {
    status = "waiting";
    reason = "Independent check awaits question assessment; gate remains closed";
  } else if (
    run.status !== "succeeded" ||
    run.report.verify?.status === "failed" ||
    run.report.criteria?.some((c: { passed: boolean }) => c.passed === false)
  ) {
    status = "failed";
    reason = `Independent ${task.stage} failed: ${run.error ?? run.report.criteria?.find((c) => !c.passed)?.text ?? run.report.verify?.output ?? run.stopReason}`;
  }
  // Failed results must be bound to the same independent session/candidate too.
  // Missing auth, old daemons or corrupted provenance need recovery, not an automatic repair.
  if (status === "failed" || status === "blocked") {
    try {
      const assignment = await factoryCheckAssignment(tx, task.userId, run.id);
      if (
        !(await factoryCheckIndependent(tx, task, run.id)) ||
        run.report?.check?.sha !== assignment.baseBranch ||
        run.report.check.readOnly !== true ||
        run.report.verify.command !== assignment.verifyCommand ||
        run.report.filesChanged?.length !== 0 ||
        !run.startedAt || !run.finishedAt ||
        !Number.isFinite(new Date(run.startedAt).getTime()) || !Number.isFinite(new Date(run.finishedAt).getTime()) ||
        new Date(run.finishedAt).getTime() < new Date(run.startedAt).getTime() ||
        !(Number.isFinite(run.report.verify.exitCode) || run.report.verify.exitCode === null) ||
        typeof run.report.verify.timedOut !== "boolean" ||
        !(run.report.verify.signal === null || typeof run.report.verify.signal === "string")
      )
        throw new FactoryError("factoryCheckBindingMismatch");
      output.trustedFailureProvenance = true;
    } catch (error) {
      if (!(error instanceof FactoryError)) throw error;
      if (status === "failed") {
        status = "blocked";
        reason = `Independent check failure provenance rejected: ${error.code}; trusted recovery required`;
      }
    }
  }
  const event = factoryEventId("check-completion", run.id);
  let finished;
  try {
    // Failed gate validation makes no writes after this savepoint.
    await tx.query("SAVEPOINT factory_check_finish");
    finished = await store.apply(
      task.userId,
      binding(task),
      event,
      {
        action: "finish",
        status,
        reason: reason.slice(0, 4000),
        evidence,
        output: completion,
      },
      tx,
    );
    await tx.query("RELEASE SAVEPOINT factory_check_finish");
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT factory_check_finish");
    if (
      !(error instanceof FactoryError) ||
      ![
        "factoryConsumerGateRequired",
        "factoryCheckBindingMismatch",
        "factoryEvidenceMismatch",
        "factoryEvidenceRequired",
        "factoryIndependentRunRequired",
      ].includes(error.code)
    )
      throw error;
    status = "blocked";
    finished = await store.apply(
      task.userId,
      binding(task),
      event,
      {
        action: "finish",
        status,
        reason: `Independent check evidence rejected: ${error.code}; trusted recovery required`,
        evidence,
        output: completion,
      },
      tx,
    );
  }
  if (status === "passed") {
    await store.apply(
      task.userId,
      binding(finished.task),
      factoryEventId("check-advance", run.id),
      {
        action: "advance",
        stage: task.stage === "review" ? "verify" : "approval",
        reason:
          task.stage === "review"
            ? "Candidate awaits a separate verification session"
            : "Independent review and verification passed; existing authorization gate pending",
      },
      tx,
    );
  }
  // Recovery strategy belongs to the Coordinator model via recover_factory_check.
  // A failed observation is retained here; no program classifies it as transient
  // or as requiring a source edit, and no executor is opened automatically.
}
