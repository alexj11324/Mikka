import type { Pool } from "pg";
import { FactoryError, type FactoryBinding } from "./contract";
import { factoryEventId } from "./event-id";
import type { FactoryTask, createFactoryStore } from "./store";
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
) {
  return async (userId: string) => {
    const { rows: pending } = await pool.query(
      "SELECT id FROM factory_tasks WHERE \"userId\"=$1 AND status='running' AND stage IN ('spec','execute') ORDER BY \"updatedAt\" LIMIT 50",
      [userId],
    );
    let recovered = 0;
    for (const item of pending) {
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        const {
          rows: [task],
        } = await tx.query<FactoryTask>(
          "SELECT * FROM factory_tasks WHERE id=$1 AND \"userId\"=$2 AND status='running' FOR UPDATE",
          [item.id, userId],
        );
        if (!task) {
          await tx.query("COMMIT");
          continue;
        }
        const {
          rows: [run],
        } = await tx.query(
          `SELECT r.*, repo."remoteUrl", repo."repoPath" FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" LEFT JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE a.id=$1 AND r."userId"=$2 AND r."issueId"=$3 FOR UPDATE OF r`,
          [task.attemptId, userId, task.issueId],
        );
        if (
          !run ||
          !["succeeded", "failed", "stopped", "cancelled"].includes(run.status)
        ) {
          await tx.query("COMMIT");
          continue;
        }
        const eventId = factoryEventId("run-completion", run.id);
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
