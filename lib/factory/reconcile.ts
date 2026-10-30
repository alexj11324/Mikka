import type { Pool, PoolClient } from "pg";
import { FactoryError, type FactoryBinding } from "./contract";
import { factoryEventId } from "./event-id";
import type { FactoryTask, createFactoryStore } from "./store";
import { MAX_RUN_ATTEMPTS } from "../run-retry";
import type { createFactoryQuestions } from "./questions/store";
import { checkFactoryRepairBudget } from "./check-recovery-evidence";

/** A failed run or a failed verify gate is a visible failed attempt that
 * re-enters the existing repair loop (retry at execute, repair from
 * review/verify/monitor) under the check-recovery cap (maxFixAttempts). Past
 * the cap the task stays failed with reasonCode repair_budget_exhausted. */
async function failIntoRepairLoop(
  tx: PoolClient,
  store: ReturnType<typeof createFactoryStore>,
  userId: string,
  task: FactoryTask,
  eventKey: string,
  reason: string,
  reasonCode: string,
  output: Record<string, unknown> = {},
) {
  const loop = task.stage === "execute" ? "retry" : ["review", "verify", "monitor"].includes(task.stage) ? "repair" : null;
  let exhausted = false;
  if (loop) {
    try {
      await checkFactoryRepairBudget(tx, task);
    } catch (error) {
      if (!(error instanceof FactoryError) || error.code !== "factoryRecoveryBudgetExceeded") throw error;
      exhausted = true;
    }
  }
  const failed = await store.apply(userId, binding(task), factoryEventId(eventKey, task.attemptId), {
    action: "finish",
    status: "failed",
    reason: (exhausted ? `Repair budget exhausted. ${reason}` : reason).slice(0, 4000),
    evidence: [],
    output: { ...output, reasonCode: exhausted ? "repair_budget_exhausted" : reasonCode },
  }, tx);
  if (!loop || exhausted) return failed;
  return store.apply(userId, binding(failed.task), factoryEventId(`${eventKey}:${loop}`, task.attemptId), {
    action: loop,
    reason: `Repair after ${reasonCode}`,
  }, tx);
}
const binding = (task: FactoryTask): FactoryBinding => ({
  taskId: task.id,
  issueId: task.issueId,
  attemptId: task.attemptId,
  revision: task.revision,
  candidateId: task.candidateId,
});

/** Consume existing durable run state during a Coordinator turn. #176 owns wake delivery. */
export function createFactoryReconciler(
  pool: Pool,
  store: ReturnType<typeof createFactoryStore>,
  questions?: Pick<
    ReturnType<typeof createFactoryQuestions>,
    "record" | "settle">,
  consumers: Partial<Record<"review" | "verify" | "monitor", (tx: PoolClient, store: ReturnType<typeof createFactoryStore>, task: FactoryTask, run: Record<string, any>) => Promise<unknown>>> = {},
  botId: string | null = null,
) {
  const PENDING = `t.stage IN ('spec','execute','review','verify','monitor') AND (t.status='running' OR (t.status='failed' AND EXISTS (SELECT 1 FROM factory_attempts a JOIN agent_runs r ON r."retryOf"=a."runId" WHERE a.id=t."attemptId")))`;
  const reconcileTasks = async (userId: string, pending: { id: string; attemptId?: string }[]) => {
    let recovered = 0;
    for (const item of pending) {
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        // Monitor evidence updates the issue document. Take its owner lock
        // before store.lockTask acquires issue SHARE locks to avoid upgrades
        // deadlocking across concurrently reconciled Bot tasks.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[JSON.stringify(["factory-monitor-owner",userId])]);
        let task = await store.lockTask(tx, userId, item.id);
        // A run completion is bound to the attempt that was current when it was
        // selected; if a reject/retry/repair replaced it meanwhile, that old
        // run must not move the task (QA #449-5).
        if (!["running", "failed"].includes(task.status) || (item.attemptId && task.attemptId !== item.attemptId)) { await tx.query("COMMIT"); continue; }
        let {
          rows: [run],
        } = await tx.query(
          `SELECT r.*, repo."remoteUrl", repo."repoPath" FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" LEFT JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE a.id=$1 AND r."userId"=$2 AND r."issueId"=$3 FOR UPDATE OF r`,
          [task.attemptId, userId, task.issueId],
        );
        if (!run && task.status === "running") {
          // The run may have disappeared while its durable question and answer
          // remain. Settle that continuation under the same task/issue lock so
          // it cannot remain "resuming" after the task is blocked.
          if (questions) {
            const { rows: [attempt] } = await tx.query(
              'SELECT "runId" FROM factory_attempts WHERE id=$1 AND "taskId"=$2',
              [task.attemptId, task.id],
            );
            if (attempt?.runId) {
              await questions.settle(userId, attempt.runId, tx);
              task = await store.lockTask(tx, userId, task.id);
            }
          }
          if (task.status === "running") await store.apply(
            userId,
            binding(task),
            factoryEventId("run-missing", task.attemptId),
            {
              action: "finish",
              status: "blocked",
              reason:
                "Bound run is unavailable or access changed; execution cannot continue",
              evidence: [],
              output: {},
            },
            tx,
          );
          await tx.query("COMMIT");
          recovered++;
          continue;
        }
        // Consume the existing bounded run-retry chain; never create a retry here.
        for (
          let retry = 1;
          ["spec", "execute"].includes(task.stage) &&
          run?.stopReason === "device_lost" &&
          !run.stopRequestedAt &&
          retry < MAX_RUN_ATTEMPTS;
          retry++
        ) {
          const {
            rows: [child],
          } = await tx.query(
            `SELECT r.*,repo."remoteUrl",repo."repoPath" FROM agent_runs r LEFT JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE r."retryOf"=$1 AND r."userId"=$2 AND r."issueId"=$3 ORDER BY r."createdAt" LIMIT 1 FOR UPDATE OF r`,
            [run.id, userId, task.issueId],
          );
          if (!child) break;
          const adopted = await store.apply(
            userId,
            binding(task),
            factoryEventId("adopt-retry", child.id),
            {
              action: "adopt_retry",
              runId: child.id,
              reason: "Resumed the existing device-loss retry; no new dispatch",
            },
            tx,
          );
          task = adopted.task;
          run = child;
        }
        if (task.status === "failed") {
          await tx.query("COMMIT");
          continue;
        }
        if (
          !run ||
          !["succeeded", "failed", "stopped", "cancelled"].includes(run.status)
        ) {
          await tx.query("COMMIT");
          continue;
        }
        if (questions) await questions.settle(userId, run.id, tx);
        task = await store.lockTask(tx, userId, task.id);
        if (task.status !== "running") { await tx.query("COMMIT"); continue; }
        const eventId = factoryEventId("run-completion", run.id);
        if (
          !
          run.stopRequestedAt &&
          ["asked_human", "blocked"].includes(run.stopReason)
        ) {
          if (questions) {
            await tx.query("SAVEPOINT question_recovery");
            try {
              await questions.settle(userId, run.id, tx);
              await questions.record(userId, run.id, tx);
            } catch (error) {
              await tx.query("ROLLBACK TO SAVEPOINT question_recovery");
              if (!(error instanceof FactoryError)) throw error;
          await store.apply(
            userId,
            binding(task),
                factoryEventId("question-recovery-blocked", run.id),
            {
              action: "finish",
                  status: "blocked",
              reason: `Question recovery blocked: ${error.code}`,
                  evidence: [],
                  output: { runId: run.id },
                },
                tx,
              );
            }
          } else {
            await store.apply(
              userId,
              binding(task),
              eventId,
              {
                action: "finish",
                status:
                  run.stopReason === "asked_human" ? "waiting" : "blocked",
                reason:
                  run.report?.openQuestions?.join("\n").slice(0, 4000) ||
                  run.report?.blockedOn ||
                  "Execution needs input; question recovery is required",
                evidence: [],
                output: { runId: run.id },
              },
              tx,
            );
          }
          await tx.query("COMMIT");
          recovered++;
          continue;
        }
        if (task.stage === "review" || task.stage === "verify" || task.stage === "monitor") {
          const consumer = consumers[task.stage];
          if (!consumer) throw new FactoryError("factoryDispatchAdapterRequired");
          await consumer(tx, store, task, run);
          await tx.query("COMMIT");
          recovered++;
          continue;
        }
        if (
          run.stopRequestedAt ||
          run.status === "cancelled" || run.stopReason === "cancelled"
        ) {
          await store.apply(
            userId,
            binding(task),
            eventId,
            {
              action: "cancel",
              reason: `Run stopped: ${run.stopReason ?? run.status}`,
            },
            tx,
          );
        } else if (run.status === "stopped") {
          await store.apply(userId,binding(task),eventId,{action:"finish",status:"blocked",reason:"Run ended without completed submission",evidence:[],output:{runId:run.id}},tx);
        } else if (run.status === "failed") {
          // A run-level retry (agent_runs.retryOf) owns recovery; do not start a second loop.
          const { rows: retrying } = await tx.query('SELECT 1 FROM agent_runs WHERE "retryOf"=$1 LIMIT 1', [run.id]);
          if (retrying.length)
            await store.apply(userId, binding(task), eventId, { action: "finish", status: "failed", reason: String(run.error ?? run.stopReason ?? "Run failed").slice(0, 4000), evidence: [], output: { runId: run.id, reasonCode: "run_failed" } }, tx);
          else
            await failIntoRepairLoop(tx, store, userId, task, `run-completion:${run.id}`, `Run failed: ${String(run.error ?? run.stopReason ?? "unknown")}`, "run_failed", { runId: run.id });
        } else {
          const sha = run.report?.publish?.commit;
          const repository = run.remoteUrl ?? run.repoPath;
          if (
            !run.sessionId ||
            !run.report ||
            !run.deviceId ||
            (task.stage === "execute" &&
              (!repository ||
                typeof sha !== "string" ||
                !/^[a-f0-9]{40}$/.test(sha)))
          ) {
            await store.apply(
              userId,
              binding(task),
              eventId,
              {
                action: "finish",
                status: "blocked",
                reason:
                  "Run ended without a traceable session, report or exact repository candidate; trusted recovery required",
                evidence: [],
                output: { runId: run.id },
              },
              tx,
            );
          } else {
            let current = task;
            if (task.stage === "execute") {
              const next = await store.apply(
                userId,
                binding(current),
                factoryEventId("run-candidate", run.id),
                {
                  action: "candidate",
                  runId: run.id,
                  candidate: {
                    sha,
                    repository,
                    environment: `device:${run.deviceId}`,
                    scope: `issue:${task.issueId}`,
                  },
                },
                tx,
              );
              current = next.task;
            }
            const next = await store.apply(
              userId,
              binding(current),
              eventId,
              {
                action: "finish",
                status: "passed",
                reason: "Persisted completed Harness run and artifact matched",
                evidence: [
                  {
                    artifact: `run-report:${run.id}`,
                    kind: "report",
                    runId: run.id,
                    sessionId: run.sessionId,
                    candidateId: current.candidateId,
                    sha: task.stage === "execute" ? sha : null,
                    environment: `device:${run.deviceId}`,
                    recordedAt: (run.finishedAt ?? new Date()).toISOString(),
                  },
                ],
                output: { runId: run.id },
              },
              tx,
            );
            await store.apply(
              userId,
              binding(next.task),
              factoryEventId("run-advance", run.id),
              {
                action: "advance",
                stage: task.stage === "spec" ? "execute" : "review",
                reason:
                  task.stage === "spec"
                    ? "Spec run complete; execution pending"
                    : "Exact candidate awaits independent review",
              },
              tx,
            );
          }
        }
        await tx.query("COMMIT");
        recovered++;
      } catch (error) {
        await tx.query("ROLLBACK");
        if (!(error instanceof FactoryError)) throw error;
        // One blocked consumer must not prevent unrelated tasks from progressing.
        // Never mutate a task whose permission or cancellation fence denied access.
        if (!["factoryNotFound", "factoryStopped", "factoryStale"].includes(error.code)) {
          try {
            await tx.query("BEGIN");
            const current = await store.lockTask(tx, userId, item.id);
            if (current.status === "running" && error.code === "factoryEvidenceMismatch")
              // Like a failed required check: visible failure with a reason code, back into the capped repair loop.
              await failIntoRepairLoop(tx, store, userId, current, `reconcile-evidence:${current.attemptId}`, "Verify gate rejected evidence: factoryEvidenceMismatch", "factoryEvidenceMismatch", { errorCode: error.code });
            else if (current.status === "running") await store.apply(userId,binding(current),
              factoryEventId(`reconcile-blocked:${error.code}`,current.attemptId),
              {action:"finish",status:"blocked",reason:`Reconciliation blocked: ${error.code}`,evidence:[],output:{errorCode:error.code}},tx);
            await tx.query("COMMIT");
          } catch (blockedError) {
            await tx.query("ROLLBACK");
            if (!(blockedError instanceof FactoryError)) throw blockedError;
          }
        }
      } finally {
        tx.release();
      }
    }
    return { recovered };
  };
  /** Coordinator-turn sweep over this user's (and Bot's) pending tasks. */
  const reconcile = async (userId: string) => {
    const { rows: pending } = await pool.query(
      `SELECT t.id FROM factory_tasks t WHERE t."userId"=$1 AND t."botId" IS NOT DISTINCT FROM $2::uuid AND ${PENDING} ORDER BY t."updatedAt" LIMIT 50`,
      [userId, botId],
    );
    return reconcileTasks(userId, pending);
  };
  /** BE-9: only the task(s) whose current attempt is bound to this run (or to a
   * run it retried), so a completion never advances an unrelated task. */
  reconcile.run = async (userId: string, runId: string) => {
    const { rows: pending } = await pool.query(
      `SELECT t.id, a.id AS "attemptId" FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
        WHERE t."userId"=$1 AND t."botId" IS NOT DISTINCT FROM $2::uuid AND ${PENDING}
          AND (a."runId"=$3::uuid OR EXISTS (SELECT 1 FROM agent_runs c WHERE c.id=$3::uuid AND c."retryOf"=a."runId")
            OR EXISTS (SELECT 1 FROM factory_questions q WHERE q."taskId"=t.id AND (q."originRunId"=$3::uuid OR q."continuationRunId"=$3::uuid)))
        ORDER BY t.id`,
      [userId, botId, runId],
    );
    return reconcileTasks(userId, pending);
  };
  return reconcile;
}
