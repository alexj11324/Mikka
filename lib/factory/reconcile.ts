import type { Pool } from "pg";
import { FactoryError, type FactoryBinding } from "./contract";
import { factoryEventId } from "./event-id";
import type { FactoryTask, createFactoryStore } from "./store";
import { reconcileFactoryCheck } from "./reconcile-check";
import { MAX_RUN_ATTEMPTS } from "../run-retry";
import type { createFactoryQuestions } from "./questions/store";
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
    "record" | "settle"
  >,
) {
  return async (userId: string) => {
    // Device-loss completion does not pass through the daemon completion route.
    // Settle durable question continuations before generic retry adoption, also
    // for monitor tasks handled by their own validator. This is replayable on
    // the existing Coordinator wake/read path; no new scheduler is introduced.
    if (questions) {
      let cursor: string | null = null;
      while (true) {
        const { rows: endedQuestions }: {
          rows: { id: string; continuationRunId: string }[];
        } = await pool.query(
          `SELECT q.id,q."continuationRunId" FROM factory_questions q
         LEFT JOIN agent_runs r ON r.id=q."continuationRunId" AND r."userId"=q."userId" AND r."issueId"=q."issueId"
         WHERE q."userId"=$1 AND q.status='resuming' AND (r.id IS NULL OR r.status IN ('succeeded','failed','stopped','cancelled'))
         AND ($2::uuid IS NULL OR q.id>$2::uuid) ORDER BY q.id LIMIT 50`,
          [userId, cursor],
        );
        for (const question of endedQuestions) {
          try {
            await questions.settle(userId, question.continuationRunId);
          } catch (error) {
            if (
              !(error instanceof FactoryError) ||
              error.code !== "factoryNotFound"
            )
              throw error;
          }
        }
        if (endedQuestions.length < 50) break;
        cursor = endedQuestions[endedQuestions.length - 1].id;
      }
    }
    const { rows: pending } = await pool.query(
      `SELECT t.id FROM factory_tasks t WHERE t."userId"=$1 AND t.stage IN ('spec','execute','review','verify') AND (t.status='running' OR (t.status='failed' AND EXISTS (SELECT 1 FROM factory_attempts a JOIN agent_runs r ON r."retryOf"=a."runId" WHERE a.id=t."attemptId"))) ORDER BY t."updatedAt" LIMIT 50`,
      [userId],
    );
    let recovered = 0;
    for (const item of pending) {
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        let {
          rows: [task],
        } = await tx.query<FactoryTask>(
          "SELECT * FROM factory_tasks WHERE id=$1 AND \"userId\"=$2 AND status IN ('running','failed') FOR UPDATE",
          [item.id, userId],
        );
        if (!task) {
          await tx.query("COMMIT");
          continue;
        }
        let {
          rows: [run],
        } = await tx.query(
          `SELECT r.*, repo."remoteUrl", repo."repoPath" FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" LEFT JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE a.id=$1 AND r."userId"=$2 AND r."issueId"=$3 FOR UPDATE OF r`,
          [task.attemptId, userId, task.issueId],
        );
        if (!run && task.status === "running") {
          await store.apply(
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
          !run.questionContinuation &&
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
        const eventId = factoryEventId("run-completion", run.id);
        if (
          !run.stopRequestedAt &&
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
        if (task.stage === "review" || task.stage === "verify") {
          await reconcileFactoryCheck(tx, store, task, run);
          await tx.query("COMMIT");
          recovered++;
          continue;
        }
        if (
          run.stopRequestedAt ||
          ["stopped", "cancelled"].includes(run.status)
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
        } else if (run.status === "failed") {
          await store.apply(
            userId,
            binding(task),
            eventId,
            {
              action: "finish",
              status: "failed",
              reason: String(run.error ?? run.stopReason ?? "Run failed").slice(
                0,
                4000,
              ),
              evidence: [],
              output: { runId: run.id },
            },
            tx,
          );
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
        if (
          !(error instanceof FactoryError) ||
          error.code !== "factoryNotFound"
        )
          throw error;
        // Current access was revoked. Do not dispatch, retry, or fabricate success.
      } finally {
        tx.release();
      }
    }
    return { recovered };
  };
}
