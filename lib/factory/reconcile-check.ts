import type { PoolClient } from "pg";
import type { RunReport } from "@mikka/protocol/run";
import { orchestratorSettings } from "@mikka/protocol/orchestrator";
import {
  FactoryError,
  type FactoryBinding,
  type FactoryEvidence,
} from "./contract";
import { factoryCheckAssignment, verifierCommandEvidence } from "./checks";
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
  run: {
    id: string;
    sessionId: string | null;
    report: RunReport | null;
    status: string;
    stopReason: string;
    stopRequestedAt: Date | null;
    error: string | null;
    finishedAt: Date | null;
  },
) {
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
    run.sessionId && run.report && candidate
      ? [
          {
            artifact: `run-report:${run.id}`,
            kind: "report",
            runId: run.id,
            sessionId: run.sessionId,
            candidateId: candidate.id,
            sha: candidate.sha,
            environment: candidate.environment,
            recordedAt: (run.finishedAt ?? new Date()).toISOString(),
          },
        ]
      : [];
  const output = {
    runId: run.id,
    stopReason: run.stopReason,
    error: run.error,
    verify: run.report?.verify,
    check: run.report?.check,
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
    attempt.output.check?.command
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
  const completion = { ...attempt.output, completion: output };
  let status: "passed" | "failed" | "blocked" | "waiting" = "passed";
  let reason =
    "Independent read-only session and real command passed on the fixed candidate";
  if (
    !run.sessionId ||
    !run.report ||
    !candidate ||
    ["blocked", "device_lost", "timeout"].includes(run.stopReason)
  ) {
    status = "blocked";
    reason = `Independent check blocked: ${run.error ?? run.report?.blockedOn ?? run.stopReason ?? "missing session/report/candidate"}`;
  } else if (run.stopReason === "asked_human") {
    status = "waiting";
    reason = "Independent check requires a human answer; gate remains closed";
  } else if (
    run.status !== "succeeded" ||
    run.report.verify?.status === "failed" ||
    run.report.criteria?.some((c: { passed: boolean }) => c.passed === false)
  ) {
    status = "failed";
    reason = `Independent ${task.stage} failed: ${run.error ?? run.report.verify?.output ?? run.stopReason}`;
  }
  // Failed results must be bound to the same independent session/candidate too.
  // Missing auth, old daemons or corrupted provenance need recovery, not an automatic repair.
  if (status === "failed") {
    try {
      const assignment = await factoryCheckAssignment(tx, task.userId, run.id);
      const { rows: reused } = await tx.query(
        `SELECT 1 FROM factory_attempts WHERE "taskId"=$1 AND id<>$2 AND ("runId"=$3 OR "sessionId"=$4)`,
        [task.id, task.attemptId, run.id, run.sessionId],
      );
      if (
        reused.length ||
        run.report?.check?.sha !== assignment.baseBranch ||
        run.report.check.readOnly !== true ||
        run.report.verify.command !== assignment.verifyCommand ||
        typeof run.report.verify.exitCode !== "number"
      )
        throw new FactoryError("factoryCheckBindingMismatch");
    } catch (error) {
      if (!(error instanceof FactoryError)) throw error;
      status = "blocked";
      reason = `Independent check failure provenance rejected: ${error.code}; trusted recovery required`;
    }
  }
  let canRepair = false;
  if (status === "failed") {
    const {
      rows: [count],
    } = await tx.query(
      `SELECT count(*)::int AS count FROM factory_attempts WHERE "taskId"=$1 AND stage='execute'`,
      [task.id],
    );
    canRepair = count.count <= orchestratorSettings({}).maxFixAttempts;
    if (!canRepair)
      reason += "; repair limit reached; manual takeover required";
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
            : "Independent review and verification passed; human approval pending",
      },
      tx,
    );
  } else if (status === "failed" && canRepair) {
    await store.apply(
      task.userId,
      binding(finished.task),
      factoryEventId("check-repair", run.id),
      {
        action: "repair",
        reason: `Repair failed ${task.stage} run ${run.id}; original command/exit/log evidence retained in attempt ${task.attemptId}`,
      },
      tx,
    );
  }
}
