import type { FactoryWorkspaceBoundary } from './background-workspace';
import type { Pool, PoolClient } from "pg";
import { FactoryError, type FactoryBinding } from "./contract";
import { completeFactoryExecution } from "./completed-execution";
import { factoryEventId } from "./event-id";
import type { FactoryCompletionDispatch, FactoryTask, createFactoryStore } from "./store";
import { MAX_RUN_ATTEMPTS } from "../run-retry";
import type { createFactoryQuestions } from "./questions/store";
import { checkFactoryRepairBudget } from "./check-recovery-evidence";
import { modelFallbackRecordSchema } from "../run-model-fallback-view";
import { AgentProfileError } from "./agent-profile-definition";

/** A failed run or a failed verify gate is a visible failed attempt that
 * re-enters the existing repair loop (retry at execute, repair from
 * review/verify/monitor) under the check-recovery cap (maxFixAttempts). Past
 * the cap the task stays failed with reasonCode repair_budget_exhausted. */
export async function failIntoRepairLoop(
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

/** A rejected role Decision blocks only the unstarted independent check.
 * Preserve the complete host tuple, including optional recovery authority. */
export function observeFactoryProfileDispatch(dispatch: FactoryCompletionDispatch): FactoryCompletionDispatch {
  return async (...args: Parameters<FactoryCompletionDispatch>) => {
    const [tx, store, prior] = args;
    const before = await store.lockTask(tx, prior.userId, prior.id);
    if (before.status !== 'pending' || !['review', 'verify'].includes(before.stage)) return dispatch(...args);
    const { factoryAuthorizationCheckpoint } = await import('./transaction');
    const restoreAuthority = factoryAuthorizationCheckpoint(tx);
    await tx.query('SAVEPOINT factory_profile_dispatch');
    try {
      const start = await dispatch(...args);
      await tx.query('RELEASE SAVEPOINT factory_profile_dispatch');
      return start;
    } catch (error) {
      // Keep completed execution/candidate evidence outside this savepoint,
      // but never commit a partial queue or its pending authorization leases.
      await tx.query('ROLLBACK TO SAVEPOINT factory_profile_dispatch');
      restoreAuthority();
      await tx.query('RELEASE SAVEPOINT factory_profile_dispatch');
      if (!(error instanceof AgentProfileError) || error.code !== 'agentProfileDecisionUnavailable') throw error;
      const current = await store.lockTask(tx, prior.userId, prior.id);
      if (current.status !== 'pending' || current.stage !== before.stage || current.attemptId !== before.attemptId ||
          current.revision !== before.revision || current.sourceEventId !== before.sourceEventId ||
          !current.candidateId || current.candidateId !== before.candidateId) throw error;
      const { rows: [attempt] } = await tx.query('SELECT * FROM factory_attempts WHERE id=$1 AND "taskId"=$2 FOR UPDATE', [current.attemptId, current.id]);
      if (!attempt || attempt.status !== 'pending' || attempt.stage !== current.stage || attempt.candidateId !== current.candidateId ||
          attempt.runId !== null || attempt.sessionId !== null || attempt.output?.requestEpoch !== current.sourceEventId) throw error;
      await store.apply(current.userId, binding(current), factoryEventId('check-dispatch-decision-unavailable', current.attemptId), {
        action: 'finish', status: 'blocked',
        reason: 'Independent check could not select an Agent Profile. Check the available profiles and retry the check.',
        evidence: [], output: { dispatch: { code: 'agentProfileDecisionUnavailable' } },
      }, tx);
    }
  };
}

/** Consume existing durable run state during a Coordinator turn. #176 owns wake delivery. */
export function createFactoryReconciler(
  pool: Pool,
  store: ReturnType<typeof createFactoryStore>,
  questions?: Pick<
    ReturnType<typeof createFactoryQuestions>,
    "record" | "settle">,
  consumers: Partial<Record<"review" | "verify" | "monitor", (tx: PoolClient, store: ReturnType<typeof createFactoryStore>, task: FactoryTask, run: Record<string, any>) => Promise<unknown>>> = {},
  botId: string | null = null,
  dispatchNext?: (tx: PoolClient, store: ReturnType<typeof createFactoryStore>, task: FactoryTask, run: Record<string, any>) => Promise<(() => Promise<void>) | undefined>,
  withWorkspace?: FactoryWorkspaceBoundary,
) {
  const PENDING = `t.stage IN ('spec','execute','review','verify','monitor') AND (t.status='running' OR
    (t.status='pending' AND EXISTS(SELECT 1 FROM factory_events f WHERE f."taskId"=t.id AND f.request->>'kind'='request_epoch' AND f.request->>'sourceEventId'=t."sourceEventId"::text)) OR
    (t.status='failed' AND EXISTS (SELECT 1 FROM factory_attempts a JOIN agent_runs r ON r."retryOf"=a."runId" WHERE a.id=t."attemptId")))`;
  const reconcileTasks = async (userId: string, pending: { id: string; attemptId?: string; completedRunId?: string }[]) => {
    let recovered = 0;
    for (const item of pending) {
      let pendingStart: (() => Promise<void>) | undefined;
      const launch = () => pendingStart?.();
      let recoveredItem = 0;
      let recovering = false;
      const transact = async (afterCommitFailure?: FactoryError) => {
      const { beginFactoryTransaction, commitFactoryTransaction, rollbackFactoryTransaction, forgetFactoryTransaction } = await import('./transaction');
      const tx = await pool.connect();
      try {
        await beginFactoryTransaction(tx);
        if (afterCommitFailure) throw afterCommitFailure;
        // Monitor evidence updates the issue document. Take its owner lock
        // before store.lockTask acquires issue SHARE locks to avoid upgrades
        // deadlocking across concurrently reconciled Bot tasks.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[JSON.stringify(["factory-monitor-owner",userId])]);
        let task = await store.lockTask(tx, userId, item.id);
        // A run completion is bound to the attempt that was current when it was
        // selected; if a reject/retry/repair replaced it meanwhile, that old
        // run must not move the task (QA #449-5).
        if (!["pending", "running", "failed"].includes(task.status) || (item.attemptId && task.attemptId !== item.attemptId)) { await commitFactoryTransaction(tx); return; }
        if (task.status === 'pending') {
          const { rows: active } = await tx.query(`SELECT 1 FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId"
            WHERE a."taskId"=$1 AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing') LIMIT 1`, [task.id]);
          const start = active.length ? undefined : await dispatchNext?.(tx, store, task, { id: item.completedRunId });
          await commitFactoryTransaction(tx);
          pendingStart = start;
          if (!active.length && dispatchNext) recoveredItem++;
          return;
        }
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
          await commitFactoryTransaction(tx);
          recoveredItem++;
          return;
        }
        // The provider's ordered continuation has its own finite model list.
        // Consuming it must not exhaust the unrelated device retry budget.
        const seen = new Set<string>();
        let transportRetries = 1;
        while (["spec", "execute", "review", "verify", "monitor"].includes(task.stage) && run && !run.stopRequestedAt && !seen.has(run.id)) {
          const provider = run.stopReason === "provider_failure";
          if (task.stage === "monitor" && !provider) break;
          const fallback = modelFallbackRecordSchema.safeParse(run.report?.modelFallback);
          if (provider ? !fallback.success || fallback.data.state !== "switched" || !fallback.data.retryRunId
            : !["device_lost", "quota_exhausted"].includes(run.stopReason) || transportRetries >= MAX_RUN_ATTEMPTS) break;
          seen.add(run.id);
          const {
            rows: [child],
          } = await tx.query(
            `SELECT r.*,repo."remoteUrl",repo."repoPath" FROM agent_runs r LEFT JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE r."retryOf"=$1 AND r."userId"=$2 AND r."issueId"=$3
              AND ($4::text IS NULL OR r.id::text=$4) ORDER BY r."createdAt" LIMIT 1 FOR UPDATE OF r`,
            [run.id, userId, task.issueId, provider && fallback.success ? fallback.data.retryRunId : null],
          );
          if (!child) break;
          const adopted = await store.apply(
            userId,
            binding(task),
            factoryEventId("adopt-retry", child.id),
            {
              action: "adopt_retry",
              runId: child.id,
              reason: provider ? "Continue with the next preferred model after the provider failed" : "Resumed the existing device-loss or quota continuation; no new dispatch",
            },
            tx,
          );
          task = adopted.task;
          run = child;
          if (!provider) transportRetries++;
        }
        if (task.status === "failed") {
          await commitFactoryTransaction(tx);
          return;
        }
        if (
          !run ||
          !["succeeded", "failed", "stopped", "cancelled"].includes(run.status)
        ) {
          await commitFactoryTransaction(tx);
          return;
        }
        if (run.status === "failed" && run.stopReason === "provider_failure") {
          const parsed = modelFallbackRecordSchema.safeParse(run.report?.modelFallback);
          const fallback = parsed.success ? parsed.data : undefined;
          if (run.stopRequestedAt || fallback?.state === "stopped") {
            await store.apply(userId, binding(task), factoryEventId("provider-stopped", run.id), {
              action: "cancel", reason: "The original request ended before model recovery could continue.",
            }, tx);
            await commitFactoryTransaction(tx);
            recoveredItem++;
            return;
          }
          if (fallback?.state === "pending") {
            // Recovery owns this durable intent. A completion replay or the
            // recovery sweep will settle it before checks or repair can run.
            await commitFactoryTransaction(tx);
            return;
          }
          await store.apply(userId, binding(task), factoryEventId("provider-blocked", run.id), {
            action: "finish", status: "blocked",
            reason: (fallback?.card?.description ?? (fallback?.state === "picked"
              ? "The selected model is unavailable. Choose another model or restore its credential."
              : "No authorized preferred model can continue this task. Restore a model or update the preferred order.")).slice(0, 4000),
            evidence: [], output: { runId: run.id, recovery: "provider_failure", reasonCode: fallback?.state === "picked" ? "model_picked_unavailable" : "model_unavailable", ...(fallback ? { modelFallback: fallback } : {}) },
          }, tx);
          await commitFactoryTransaction(tx);
          recoveredItem++;
          return;
        }
        if (run.report?.repositorySelection && !run.stopRequestedAt && run.stopReason === 'blocked') {
          const { switchFactoryRepository } = await import('./repository-selection');
          await tx.query('SAVEPOINT repository_selection');
          let start: (() => Promise<void>) | undefined;
          try { start = await switchFactoryRepository(pool, tx, store, task, run); }
          catch (error) {
            await tx.query('ROLLBACK TO SAVEPOINT repository_selection');
            if (error instanceof FactoryError && ['factoryNotFound', 'factoryStopped', 'factoryStale'].includes(error.code)) throw error;
            await store.apply(userId, binding(task), factoryEventId('repository-selection-unavailable', run.id), {
              action: 'finish', status: 'blocked', reason: 'The selected repository could not be admitted with the original runtime and credential; previous work is retained.',
              evidence: [], output: { runId: run.id, reasonCode: 'repository_selection_unavailable' },
            }, tx);
          }
          await tx.query('RELEASE SAVEPOINT repository_selection');
          await commitFactoryTransaction(tx);
          pendingStart = start;
          recoveredItem++;
          return;
        }
        if (questions) await questions.settle(userId, run.id, tx);
        task = await store.lockTask(tx, userId, task.id);
        if (task.status !== "running") { await commitFactoryTransaction(tx); return; }
        const eventId = factoryEventId("run-completion", run.id);
        if (
          run.status === 'stopped' && !run.stopRequestedAt &&
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
          await commitFactoryTransaction(tx);
          recoveredItem++;
          return;
        }
        if (task.stage === "review" || task.stage === "verify" || task.stage === "monitor") {
          const consumer = consumers[task.stage];
          if (!consumer) throw new FactoryError("factoryDispatchAdapterRequired");
          await consumer(tx, store, task, run);
          const start = await dispatchNext?.(tx, store, task, run);
          await commitFactoryTransaction(tx);
          pendingStart = start;
          recoveredItem++;
          return;
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
          else if (run.stopReason === "device_lost")
            // The lease host already exhausted/denied safe takeover. A generic
            // repair would silently dispatch back to that same offline device.
            await store.apply(userId, binding(task), eventId, { action: "finish", status: "blocked", reason: String(run.error ?? "No authorized online device can continue this task").slice(0, 4000), evidence: [], output: { runId: run.id, reasonCode: "device_recovery_unavailable" } }, tx);
          else
            await failIntoRepairLoop(tx, store, userId, task, `run-completion:${run.id}`, `Run failed: ${String(run.error ?? run.stopReason ?? "unknown")}`, "run_failed", { runId: run.id });
        } else {
          await completeFactoryExecution(tx, store, task, run);
        }
        const start = await dispatchNext?.(tx, store, task, run);
        await commitFactoryTransaction(tx);
        pendingStart = start;
        recoveredItem++;
      } catch (error) {
        recovering = true;
        await rollbackFactoryTransaction(tx);
        if (!(error instanceof FactoryError)) throw error;
        // One blocked consumer must not prevent unrelated tasks from progressing.
        // Never mutate a task whose permission or cancellation fence denied access.
        if (!["factoryNotFound", "factoryStopped", "factoryStale"].includes(error.code)) {
          try {
            await beginFactoryTransaction(tx);
            const current = await store.lockTask(tx, userId, item.id);
            if (current.status === "running" && error.code === "factoryEvidenceMismatch")
              // Like a failed required check: visible failure with a reason code, back into the capped repair loop.
              await failIntoRepairLoop(tx, store, userId, current, `reconcile-evidence:${current.attemptId}`, "Verify gate rejected evidence: factoryEvidenceMismatch", "factoryEvidenceMismatch", { errorCode: error.code });
            else if (current.status === "running") await store.apply(userId,binding(current),
              factoryEventId(`reconcile-blocked:${error.code}`,current.attemptId),
              {action:"finish",status:"blocked",reason:`Reconciliation blocked: ${error.code}`,evidence:[],output:{errorCode:error.code}},tx);
            const start = await dispatchNext?.(tx, store, current, {});
            await commitFactoryTransaction(tx);
            pendingStart = start;
          } catch (blockedError) {
            await rollbackFactoryTransaction(tx);
            if (!(blockedError instanceof FactoryError)) throw blockedError;
          }
        }
      } finally {
        forgetFactoryTransaction(tx); tx.release();
      }
      };
      const admitted = (failure?: FactoryError) => withWorkspace
        ? withWorkspace(userId, item.id, () => transact(failure))
        : transact(failure);
      try {
        await admitted();
        // A committed dispatch may enqueue workflow work using these pools.
        // Release both owned leases first; the launch retains its own fences.
        try { await launch(); recovered += recoveredItem; }
        catch (error) {
          if (!(error instanceof FactoryError)) throw error;
          // Preserve the prior one-recovery error contract, with a fresh
          // admitted APP transaction instead of reusing a released client.
          if (!recovering) {
            pendingStart = undefined;
            await admitted(error);
            try { await launch(); }
            catch (recoveryError) { if (!(recoveryError instanceof FactoryError)) throw recoveryError; }
          }
        }
      } catch (error) {
        if (!(error instanceof FactoryError) || error.code !== 'factoryNotFound') throw error;
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
      `SELECT t.id, a.id AS "attemptId",$3::uuid AS "completedRunId" FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
        WHERE t."userId"=$1 AND t."botId" IS NOT DISTINCT FROM $2::uuid AND ${PENDING}
          AND (a."runId"=$3::uuid OR EXISTS (SELECT 1 FROM agent_runs c WHERE c.id=$3::uuid AND c."retryOf"=a."runId")
            OR EXISTS (SELECT 1 FROM factory_questions q WHERE q."taskId"=t.id AND (q."originRunId"=$3::uuid OR q."continuationRunId"=$3::uuid))
            OR (t.status='pending' AND EXISTS(SELECT 1 FROM factory_events f WHERE f."taskId"=t.id
              AND f.request->>'kind'='request_epoch' AND f.request->>'sourceEventId'=t."sourceEventId"::text
              AND f.request->'supersededRunIds' ? $3::text))
            OR (t.status='pending' AND EXISTS(SELECT 1 FROM coordinator_events e WHERE e.id=t."sourceEventId" AND e."userId"=$1
              AND e.payload->>'source'='thread_continuation' AND e.payload->>'previousRunId'=$3::text)))
        ORDER BY t.id`,
      [userId, botId, runId],
    );
    return reconcileTasks(userId, pending);
  };
  return reconcile;
}
