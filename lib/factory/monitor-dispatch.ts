import type { PoolClient } from "pg";
import { DEVICE_ONLINE_WINDOW_MS } from "@mikka/protocol/device";
import { FactoryError } from "./contract";
import type { FactoryTask } from "./store";
import { digest } from "./evidence";
import { readFactoryPublicationReceipt } from "./publication-receipt";

type Publication = Awaited<ReturnType<typeof readFactoryPublicationReceipt>>;
const live = ["queued", "preparing", "running", "waiting_input", "finishing"];
function fail(code: string): never {
  throw new FactoryError(code);
}

/** Called under the existing task lock, including on a dispatch replay. */
export async function readMonitorDispatchPublication(
  tx: PoolClient,
  task: FactoryTask,
) {
  const {
    rows: [current],
  } = await tx.query(
    `SELECT t.*,a."runId",a.stage AS "attemptStage",a.status AS "attemptStatus",a."candidateId" AS "attemptCandidateId" FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
     WHERE t.id=$1 AND t."userId"=$2 FOR UPDATE OF a`,
    [task.id, task.userId],
  );
  if (!current || current.issueId !== task.issueId) fail("factoryNotFound");
  if (["cancelled", "revoked"].includes(current.status)) fail("factoryStopped");
  if (
    current.attemptId !== task.attemptId ||
    current.candidateId !== task.candidateId
  )
    fail("factoryStale");
  if (
    current.stage !== "monitor" ||
    current.attemptStage !== "monitor" ||
    current.attemptStatus !== current.status ||
    current.attemptCandidateId !== current.candidateId ||
    !["pending", "running"].includes(current.status) ||
    !current.candidateId
  )
    fail("factoryTransition");
  const receipt = await readFactoryPublicationReceipt(
    tx,
    task.userId,
    task.id,
    current.candidateId,
  );
  // This increment supports already-authorized preview observation only.
  if (
    receipt.action !== "deploy_preview" ||
    receipt.verifiedTarget.kind === "merge"
  )
    fail("factoryMonitorProbeUnavailable");
  return receipt;
}

async function monitorRun(
  tx: Pick<PoolClient, "query">,
  task: FactoryTask,
  runId: string,
) {
  const {
    rows: [row],
  } = await tx.query(
    `SELECT r.*,c.sha,c.repository,c.environment,c.scope,repo."verifyCommand",repo."remoteUrl",repo."repoPath",
      d.enabled,d."lastSeenAt",d.harnesses,a.harness,fa.output,fa."runId" AS "boundRunId"
     FROM agent_runs r JOIN factory_tasks t ON t.id=$1 AND t."userId"=$2
     JOIN factory_attempts fa ON fa.id=t."attemptId" AND fa."taskId"=t.id
     JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
     JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."deviceId"=r."deviceId" AND repo."userId"=$2
     JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=$2
     JOIN agents a ON a.id=r."agentId" AND a."userId"=$2 AND a."deviceId"=d.id
     WHERE r.id=$3 AND r."userId"=$2 AND r."issueId"=$4 FOR SHARE OF repo,d,a`,
    [task.id, task.userId, runId, task.issueId],
  );
  if (
    !row ||
    row.environment !== `device:${row.deviceId}` ||
    row.repository !== (row.remoteUrl ?? row.repoPath)
  )
    fail("factoryEvidenceMismatch");
  if (row.stopRequestedAt || !live.includes(row.status) || row.retryOf)
    fail("factoryMonitorRunUnavailable");
  if (
    !row.enabled ||
    !row.lastSeenAt ||
    Date.now() - row.lastSeenAt.getTime() > DEVICE_ONLINE_WINDOW_MS ||
    !row.harnesses?.some(
      (h: { harness: string; installed: boolean }) =>
        h.harness === row.harness && h.installed,
    )
  )
    fail("factoryCheckHarnessUnavailable");
  return row;
}

function publicationBinding(receipt: Publication) {
  return {
    publicationId: receipt.publicationId,
    approvalId: receipt.approvalId,
    candidateId: receipt.candidateId,
    candidate: receipt.candidate,
    action: receipt.action,
    target: receipt.target,
    targetEnvironment: receipt.targetEnvironment,
    reference: receipt.reference,
    verifiedTarget: receipt.verifiedTarget,
  };
}

/** Freeze trusted receipt/command metadata on the existing attempt, never a second state source. */
export async function configureFactoryMonitorDispatch(
  tx: PoolClient,
  task: FactoryTask,
  runId: string,
  receipt: Publication,
  replayed: boolean,
) {
  const row = await monitorRun(tx, task, runId);
  if (replayed) {
    const metadata = row.output?.monitorDispatch;
    if (
      row.boundRunId !== runId ||
      row.kind !== "acceptance" ||
      row.baseBranch !== receipt.candidate.sha ||
      !metadata?.command ||
      !metadata.publication ||
      metadata.deviceRepoId !== row.deviceRepoId ||
      digest(metadata.publication) !== digest(publicationBinding(receipt))
    )
      fail("factoryCheckBindingMismatch");
    return;
  }
  if (!row.verifyCommand?.trim()) fail("factoryCheckCommandRequired");
  if (row.boundRunId) fail("factoryCheckBindingMismatch");
  const metadata = {
    version: 1,
    command: row.verifyCommand,
    deviceRepoId: row.deviceRepoId,
    publication: publicationBinding(receipt),
  };
  const prompt = [
    `Factory stage: monitor. Observe the already-published candidate ${receipt.candidateId}, commit ${receipt.candidate.sha}.`,
    `Target: ${receipt.target}; environment: ${receipt.targetEnvironment}; publication receipt: ${receipt.reference}.`,
    `This is a read-only observation, not permission to deploy, merge, repair or change files. Execute the frozen repository verification command: ${row.verifyCommand}. Submit its actual observations.`,
    "The trusted server independently probes the frozen publication target; your self-report cannot establish target health or authorize any external action.",
    "Original issue and standing instructions:",
    "",
  ].join("\n");
  await tx.query(
    `UPDATE agent_runs SET kind='acceptance',"baseBranch"=$2,prompt=$3 || left(prompt,$4) WHERE id=$1`,
    [runId, receipt.candidate.sha, prompt, 100000 - prompt.length],
  );
  await tx.query(
    `UPDATE factory_attempts SET output=jsonb_set(output,'{monitorDispatch}',$2::jsonb) WHERE id=$1`,
    [task.attemptId, JSON.stringify(metadata)],
  );
}

/** Existing check-claim path calls this under task/access locks before claiming. */
export async function factoryMonitorDispatchAssignment(
  tx: PoolClient,
  userId: string,
  runId: string,
) {
  const {
    rows: [task],
  } = await tx.query<FactoryTask>(
    `SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
     WHERE a."runId"=$1 AND t."userId"=$2`,
    [runId, userId],
  );
  if (!task || task.stage !== "monitor" || task.status !== "running")
    fail("factoryCheckBindingMismatch");
  const receipt = await readMonitorDispatchPublication(tx, task);
  await configureFactoryMonitorDispatch(tx, task, runId, receipt, true);
  const row = await monitorRun(tx, task, runId);
  return {
    baseBranch: receipt.candidate.sha,
    verifyCommand: row.output.monitorDispatch.command as string,
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
