import type { PoolClient } from "pg";
import { DEVICE_ONLINE_WINDOW_MS } from "@mikka/protocol/device";
import { FactoryError } from "./contract";
import type { FactoryGate, FactoryTask } from "./store";

// Internal dispatch metadata on the existing attempt, never a second stage source.
export async function configureFactoryCheck(
  tx: PoolClient,
  task: FactoryTask,
  runId: string,
) {
  const {
    rows: [row],
  } = await tx.query(
    `SELECT c.*,r."deviceId",r."deviceRepoId",repo."verifyCommand",repo."remoteUrl",repo."repoPath",d.enabled,d."lastSeenAt",d.harnesses,a.harness
     FROM factory_candidates c JOIN agent_runs r ON r.id=$3
     JOIN device_repos repo ON repo.id=r."deviceRepoId"
     JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=$4
     JOIN agents a ON a.id=r."agentId" AND a."userId"=$4 AND a."deviceId"=d.id
     WHERE c.id=$1 AND c."taskId"=$2 AND r."userId"=$4 AND r."issueId"=$5
     AND repo."userId"=$4 AND repo."deviceId"=r."deviceId" FOR SHARE OF repo,d,a`,
    [task.candidateId, task.id, runId, task.userId, task.issueId],
  );
  if (
    !row ||
    row.environment !== `device:${row.deviceId}` ||
    row.repository !== (row.remoteUrl ?? row.repoPath)
  )
    throw new FactoryError("factoryEvidenceMismatch");
  if (
    !row.enabled ||
    !row.lastSeenAt ||
    Date.now() - row.lastSeenAt.getTime() > DEVICE_ONLINE_WINDOW_MS ||
    !row.harnesses?.some(
      (h: { harness: string; installed: boolean }) =>
        h.harness === row.harness && h.installed,
    )
  )
    throw new FactoryError("factoryCheckHarnessUnavailable");
  if (!row.verifyCommand?.trim())
    throw new FactoryError("factoryCheckCommandRequired");
  const {
    rows: [previousFailure],
  } = await tx.query(
    `SELECT c.sha FROM factory_attempts a JOIN factory_candidates c ON c.id=a."candidateId" WHERE a."taskId"=$1 AND a.stage IN ('review','verify') AND a.status='failed' ORDER BY a.position DESC LIMIT 1`,
    [task.id],
  );
  if (previousFailure?.sha === row.sha)
    throw new FactoryError("factoryCheckUnchangedCandidate");
  const check = {
    stage: task.stage,
    candidateId: row.id,
    sha: row.sha,
    repository: row.repository,
    environment: row.environment,
    command: row.verifyCommand,
    deviceRepoId: row.deviceRepoId,
  };
  const prompt = [
    `Factory stage: ${task.stage}. Independent read-only check of candidate ${row.id}, commit ${row.sha}.`,
    task.stage === "review"
      ? "Review the fixed candidate for correctness and regressions. Record each material finding as a failed criterion; explicitly pass a criterion only with concrete evidence."
      : "Independently exercise the acceptance criteria against this fixed candidate using real commands and observations. Record every criterion with its evidence. Code inspection alone is not verification.",
    "Do not change files or git state. Submit your criteria and evidence. The daemon separately executes the frozen verify command; your self-report cannot replace it.",
    "\nOriginal issue and standing instructions:\n",
  ].join("\n");
  await tx.query(
    `UPDATE agent_runs SET kind='check',"baseBranch"=$2,prompt=$3 || left(prompt,$4) WHERE id=$1`,
    [runId, row.sha, prompt, 100000 - prompt.length],
  );
  await tx.query(`UPDATE factory_attempts SET output=$2 WHERE id=$1`, [
    task.attemptId,
    JSON.stringify({ check }),
  ]);
}

/** Frozen assignment for a bound check. Called before claiming; fails closed after a stop/repair. */
export async function factoryCheckAssignment(
  tx: Pick<PoolClient, "query">,
  userId: string,
  runId: string,
) {
  const {
    rows: [row],
  } = await tx.query(
    `SELECT t.stage,t.status,t."candidateId",a.output,r."baseBranch",r.kind,r."deviceRepoId",r."deviceId",r."retryOf",c.sha,c.environment
     FROM factory_attempts a JOIN factory_tasks t ON t."attemptId"=a.id
     JOIN agent_runs r ON r.id=a."runId" JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
     WHERE r.id=$1 AND t."userId"=$2 AND r."userId"=$2 AND r."issueId"=t."issueId"`,
    [runId, userId],
  );
  const check = row?.output?.check;
  if (
    !row ||
    !["review", "verify"].includes(row.stage) ||
    row.status !== "running" ||
    row.kind !== "check" ||
    row.retryOf ||
    check?.stage !== row.stage ||
    check?.candidateId !== row.candidateId ||
    check?.sha !== row.sha ||
    row.baseBranch !== row.sha ||
    check?.deviceRepoId !== row.deviceRepoId ||
    check?.environment !== `device:${row.deviceId}` ||
    check?.environment !== row.environment ||
    !check?.command
  )
    throw new FactoryError("factoryCheckBindingMismatch");
  return {
    baseBranch: row.sha as string,
    verifyCommand: check.command as string,
    // Existing daemon policy enforces the filesystem and Harness tool boundary.
    policy: {
      readOnly: true,
      networkAllow: [],
      permissions: {
        install_dependency: "deny" as const,
        write_outside_repo: "deny" as const,
        git_push: "deny" as const,
        network: "ask" as const,
      },
    },
  };
}

const checkGate: FactoryGate = async (tx, task, attempt, change) => {
  if (!attempt.runId || !task.candidateId) return false;
  const assignment = await factoryCheckAssignment(
    tx,
    task.userId,
    attempt.runId,
  );
  const {
    rows: [run],
  } = await tx.query(
    `SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 FOR UPDATE`,
    [attempt.runId, task.userId, task.issueId],
  );
  const report = run?.report;
  if (
    run?.status !== "succeeded" ||
    run.stopReason !== "submitted" ||
    !run.sessionId ||
    report?.check?.sha !== assignment.baseBranch ||
    report?.check?.readOnly !== true ||
    report?.verify?.status !== "passed" ||
    report.verify.command !== assignment.verifyCommand ||
    report.verify.exitCode !== 0 ||
    report.verify.timedOut !== false ||
    report.verify.signal !== null ||
    report.filesChanged?.length !== 0 ||
    !report.criteria?.length ||
    report.criteria.some(
      (c: { passed?: boolean; evidence?: string }) =>
        c.passed !== true || !c.evidence?.trim(),
    ) ||
    change.evidence.some(
      (e) => e.runId !== run.id || e.sessionId !== run.sessionId,
    )
  )
    return false;
  return true;
};
export const factoryCheckGates = { review: checkGate, verify: checkGate };

/** Hand back the original immutable report/chunk references, not an executor's paraphrase. */
export async function factoryRepairBrief(
  tx: PoolClient,
  task: FactoryTask,
  runId: string,
) {
  const {
    rows: [failed],
  } = await tx.query(
    `SELECT * FROM factory_attempts WHERE "taskId"=$1 AND stage IN ('review','verify') AND status='failed' ORDER BY position DESC LIMIT 1`,
    [task.id],
  );
  if (!failed) return;
  const brief = `Factory repair of ${failed.stage} attempt ${failed.id}, run ${failed.runId}, session ${failed.sessionId}.\nReason: ${failed.reason}\nOriginal persisted evidence: ${JSON.stringify(failed.evidence)}\nFailure output: ${JSON.stringify(failed.output)}\nProduce a new commit. It must pass fresh independent review and verification.\n\n`;
  await tx.query(
    `UPDATE agent_runs SET prompt=$2 || left(prompt,$3) WHERE id=$1`,
    [runId, brief, 100000 - brief.length],
  );
}
