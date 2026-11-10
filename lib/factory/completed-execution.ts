import { factoryNextStage } from './flow'
import { factoryFlowVersion } from './contract'
import type { PoolClient } from 'pg'
import type { FactoryEvidence, FactoryBinding } from './contract'
import { runCaptureEvidence } from './evidence'
import { factoryEventId } from './event-id'
import type { createFactoryStore, FactoryTask } from './store'

const binding = (task: FactoryTask): FactoryBinding => ({ taskId: task.id, issueId: task.issueId, attemptId: task.attemptId, revision: task.revision, candidateId: task.candidateId })

/** Consume the persisted successful execution through the canonical candidate and evidence gates. */
export async function completeFactoryExecution(tx: PoolClient, store: Pick<ReturnType<typeof createFactoryStore>, 'apply'>, task: FactoryTask, run: Record<string, any>): Promise<FactoryTask> {
  const userId = task.userId
  const eventId = factoryEventId('run-completion', run.id)
  const sha = run.report?.publish?.commit ?? ((run.agentDefinition?.readOnly || !run.remoteUrl) ? run.report?.sourceCommit : undefined);
  const repository = run.remoteUrl ?? run.repoPath;
  const deliverable = !run.remoteUrl && typeof run.repoPath === 'string' && run.repoPath.startsWith('/home/user/.mikka/bot-workspaces/');
  if (
    !run.sessionId ||
    !run.report ||
    !run.deviceId ||
    (task.stage === "execute" &&
      (!repository ||
        (!deliverable && (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)))))
  ) {
    const blocked = await store.apply(
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
    return blocked.task;
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
            sha: deliverable ? null : sha,
            ...(deliverable ? { kind: 'deliverable' as const } : run.agentDefinition?.readOnly || !run.remoteUrl ? { kind: 'report' as const } : {}),
            repository,
            environment: `device:${run.deviceId}`,
            scope: `issue:${task.issueId}`,
          },
        },
        tx,
      );
      current = next.task;
    }
    const report: FactoryEvidence = {
      artifact: `run-report:${run.id}`,
      kind: "report",
      runId: run.id,
      sessionId: run.sessionId,
      candidateId: current.candidateId,
      sha: task.stage === "execute" && !deliverable ? sha : null,
      environment: `device:${run.deviceId}`,
      recordedAt: (run.finishedAt ?? new Date()).toISOString(),
    };
    const next = await store.apply(
      userId,
      binding(current),
      eventId,
      {
        action: "finish",
        status: "passed",
        reason: "Persisted completed Harness run and artifact matched",
        // The report, then the screenshots and recordings the run took.
        evidence: [report, ...(await runCaptureEvidence(tx, { id: run.id, userId }, report))],
        output: { runId: run.id },
      },
      tx,
    );
    if (next.task.status !== 'passed' || (task.stage === 'spec' && factoryFlowVersion(task) === 2)) return next.task;
    const stage = await factoryNextStage(tx, next.task);
    const advanced = await store.apply(
      userId,
      binding(next.task),
      factoryEventId("run-advance", run.id),
      {
        action: "advance",
        stage: stage!,
        reason:
          task.stage === "spec"
            ? "Spec run complete; execution pending"
            : stage === "approval"
              ? "Implementation and its validation are ready for the person; this task was already reviewed"
              : "Exact candidate awaits independent review",
      },
      tx,
    );
    return advanced.task;
  }
}
