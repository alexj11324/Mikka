import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { FactoryError } from "../factory/contract";
import type { FactoryTask } from "../factory/store";
import type { PublicationAdapter } from "../factory/approval";
import {
  publicationBindingHash,
  type PublicationInput,
} from "../factory/publication-operation";
import type { PublicationAdapterReceipt } from "../factory/publication-receipt";
import { digest } from "./contract";
import { isModelEvaluationResult } from "./evaluation-comparison";
import { lockSkillScope, resolveSkillVersion } from "./registry";

export const SKILL_ACTIVATION_TARGET = "mikka-builtin:run-report";
type Registered = Awaited<ReturnType<typeof resolveSkillVersion>>;
export type SkillActivationDependencies = {
  readRegisteredCandidate(
    tx: PoolClient,
    userId: string,
    taskId: string,
    candidateId: string,
  ): Promise<Registered>;
  passingEvaluation(
    tx: PoolClient,
    userId: string,
    proposalId: string,
    versionId: string,
    evaluationId: string,
  ): Promise<{ evaluationId: string; digest: string; result: unknown }>;
};
function fail(): never {
  throw new FactoryError("factorySkillActivationEvidenceRequired");
}

/** Bind the exact immutable bytes/result into the existing authenticated evidence read. */
export async function readSkillApprovalEvidence(
  tx: PoolClient,
  task: Pick<FactoryTask, "id" | "userId" | "issueId" | "candidateId">,
) {
  const {
    rows: [metadata],
  } = await tx.query(
    'SELECT * FROM improvement_skill_candidates WHERE "factoryTaskId"=$1 AND "candidateId"=$2 AND "userId"=$3',
    [task.id, task.candidateId, task.userId],
  );
  if (!metadata) return undefined;
  if (metadata.issueId !== task.issueId) fail();
  await tx.query("SELECT id FROM issues WHERE id=$1 FOR SHARE", [task.issueId]);
  await lockSkillScope(tx, task.userId, task.issueId, metadata.repoId);
  const version = await resolveSkillVersion(
    tx,
    task.userId,
    {
      issueId: task.issueId,
      agentId: metadata.agentId,
      deviceRepoId: metadata.repoId,
    },
    metadata.versionId,
  );
  const {
    rows: [evaluation],
  } = await tx.query(
    `SELECT e.id,e.scope,r.result,r.digest FROM improvement_skill_evaluations e
    JOIN improvement_evaluation_results r ON r."evaluationId"=e.id
    WHERE e."userId"=$1 AND e."proposalId"=$2 AND e."candidateVersionId"=$3 ORDER BY e."createdAt" DESC,e.id DESC LIMIT 1`,
    [task.userId, metadata.proposalId, metadata.versionId],
  );
  if (
    !evaluation ||
    !isModelEvaluationResult(evaluation.result) ||
    evaluation.result.passed !== true ||
    evaluation.digest !== digest(evaluation.result) ||
    evaluation.result.evaluationId !== evaluation.id ||
    evaluation.result.proposalId !== metadata.proposalId ||
    evaluation.result.candidateVersionId !== metadata.versionId ||
    evaluation.scope?.factoryTaskId !== task.id ||
    evaluation.scope?.candidateId !== task.candidateId ||
    evaluation.scope?.issueId !== task.issueId ||
    evaluation.scope?.agentId !== metadata.agentId ||
    evaluation.scope?.repoId !== metadata.repoId ||
    digest(evaluation.scope) !== digest(evaluation.result.scope)
  )
    fail();
  return {
    artifact: version.artifact,
    markdown: version.markdown,
    metadata: version.metadata!,
    evaluation: {
      evaluationId: evaluation.id as string,
      digest: evaluation.digest as string,
      result: evaluation.result as unknown,
    },
  };
}

export function createSkillActivationAdapters(
  dependencies: SkillActivationDependencies,
): PublicationAdapter[] {
  return (["preview", "production"] as const).map((environment) => {
    async function execute(
      input: PublicationInput,
      tx?: PoolClient,
      readOnly = false,
    ): Promise<PublicationAdapterReceipt> {
      const a = input.authorization;
      if (
        !tx ||
        !a ||
        a.action !== "activate_skill" ||
        a.target !== SKILL_ACTIVATION_TARGET ||
        a.targetEnvironment !== environment ||
        !a.binding.candidateId
      )
        fail();
      const {
        rows: [task],
      } = await tx.query<FactoryTask>(
        'SELECT * FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR UPDATE',
        [a.binding.taskId, a.ownerId],
      );
      if (
        !task ||
        task.issueId !== a.binding.issueId ||
        task.candidateId !== a.binding.candidateId ||
        task.attemptId !== a.binding.attemptId ||
        task.revision !== a.binding.revision ||
        task.stage !== "publish" ||
        task.status !== "pending"
      )
        fail();
      const evidence = await readSkillApprovalEvidence(tx, task);
      if (!evidence) fail();
      const registered = await dependencies.readRegisteredCandidate(
        tx,
        a.ownerId,
        task.id,
        task.candidateId!,
      );
      const m = registered.metadata;
      if (
        !m ||
        m.commitSha !== input.candidate.sha ||
        m.repository !== input.candidate.repository ||
        m.candidateId !== task.candidateId ||
        digest(registered.artifact) !== digest(evidence.artifact) ||
        registered.markdown !== evidence.markdown
      )
        fail();
      const evaluation = await dependencies.passingEvaluation(
        tx,
        a.ownerId,
        m.proposalId,
        m.versionId,
        evidence.evaluation.evaluationId,
      );
      if (digest(evaluation) !== digest(evidence.evaluation)) fail();
      const {
        rows: [withdrawn],
      } = await tx.query(
        `SELECT id FROM improvement_skill_lifecycle WHERE "versionId"=$1 AND operation='withdraw'`,
        [m.versionId],
      );
      if (withdrawn) fail();
      if (!readOnly) {
        if (!input.beforeCreate) fail();
        await input.beforeCreate();
        await tx.query(
          `INSERT INTO improvement_skill_lifecycle(id,"userId","issueId","repoId","versionId",operation,"publicationId","approvalId")
          VALUES($1,$2,$3,$4,$5,'activate',$6,$7) ON CONFLICT ("publicationId",operation) DO NOTHING`,
          [
            randomUUID(),
            a.ownerId,
            m.issueId,
            m.repoId,
            m.versionId,
            input.idempotencyKey,
            a.approvalId,
          ],
        );
      }
      const {
        rows: [activation],
      } = await tx.query(
        `SELECT * FROM improvement_skill_lifecycle WHERE "publicationId"=$1 AND operation='activate'`,
        [input.idempotencyKey],
      );
      const {
        rows: [latest],
      } = await tx.query(
        `SELECT * FROM improvement_skill_lifecycle WHERE "userId"=$1 AND "issueId"=$2 AND "repoId"=$3 ORDER BY "createdAt" DESC,id DESC LIMIT 1`,
        [a.ownerId, m.issueId, m.repoId],
      );
      if (
        !activation ||
        activation.userId !== a.ownerId ||
        activation.issueId !== m.issueId ||
        activation.repoId !== m.repoId ||
        activation.versionId !== m.versionId ||
        activation.approvalId !== a.approvalId ||
        latest?.id !== activation.id
      )
        fail();
      const observed = await resolveSkillVersion(
        tx,
        a.ownerId,
        { issueId: m.issueId, agentId: m.agentId, deviceRepoId: m.repoId },
        m.versionId,
      );
      if (
        digest(observed.artifact) !== digest(registered.artifact) ||
        observed.markdown !== registered.markdown
      )
        fail();
      const reference = `skill-activation:${input.idempotencyKey}:${m.versionId}:sha256:${observed.artifact.sha256}`;
      return {
        reference,
        verifiedTarget: {
          kind: "skill-activation",
          operationId: input.idempotencyKey,
          target: SKILL_ACTIVATION_TARGET,
          environment,
          repository: m.repository,
          sha: m.commitSha,
          reference,
          observedAt: new Date().toISOString(),
          skill: {
            version: 1,
            publicationId: input.idempotencyKey,
            bindingHash: publicationBindingHash(input),
            versionId: m.versionId,
            sha256: observed.artifact.sha256,
            proposalId: m.proposalId,
            evaluationId: evaluation.evaluationId,
          },
        },
      };
    }
    return {
      action: "activate_skill",
      target: SKILL_ACTIVATION_TARGET,
      environment,
      execute: (input, tx) => execute(input, tx),
      reconcile: (input, _checkpoint, tx) => execute(input, tx, true),
    };
  });
}

/** Caller holds the Factory task and issue locks; withdrawal and approval revocation commit together. */
export async function withdrawSkillApproval(
  tx: PoolClient,
  task: FactoryTask,
  approvalId: string,
) {
  const {
    rows: [activation],
  } = await tx.query(
    `SELECT l.* FROM improvement_skill_lifecycle l JOIN factory_publications p ON p.id=l."publicationId"
    WHERE l."approvalId"=$1 AND l.operation='activate' AND l."userId"=$2 AND p."taskId"=$3 AND p.action='activate_skill'`,
    [approvalId, task.userId, task.id],
  );
  if (!activation) return;
  await lockSkillScope(tx, task.userId, task.issueId, activation.repoId);
  await tx.query(
    `INSERT INTO improvement_skill_lifecycle(id,"userId","issueId","repoId","versionId",operation,"publicationId","approvalId")
    VALUES($1,$2,$3,$4,$5,'withdraw',$6,$7) ON CONFLICT ("publicationId",operation) DO NOTHING`,
    [
      randomUUID(),
      task.userId,
      task.issueId,
      activation.repoId,
      activation.versionId,
      activation.publicationId,
      approvalId,
    ],
  );
}

export async function lockSkillPublication(
  tx: PoolClient,
  receipt: {
    action: string;
    taskId: string;
    candidateId: string;
    issueId: string;
  },
  userId: string,
) {
  if (receipt.action !== "activate_skill") return;
  const {
    rows: [metadata],
  } = await tx.query(
    'SELECT * FROM improvement_skill_candidates WHERE "factoryTaskId"=$1 AND "candidateId"=$2 AND "userId"=$3',
    [receipt.taskId, receipt.candidateId, userId],
  );
  if (!metadata || metadata.issueId !== receipt.issueId) fail();
  await tx.query("SELECT id FROM issues WHERE id=$1 FOR SHARE", [
    receipt.issueId,
  ]);
  await lockSkillScope(tx, userId, receipt.issueId, metadata.repoId);
}

/** Host receipt and persisted mount establish adoption; the model's summary cannot. */
export async function probeSkillActivation(
  tx: PoolClient,
  receipt: Awaited<
    ReturnType<
      typeof import("../factory/publication-receipt").readFactoryPublicationReceiptV2
    >
  >,
  runId: string,
  userId: string,
  completionReport?: unknown,
) {
  const proof = receipt.verifiedTarget.skill;
  if (receipt.action !== "activate_skill" || !proof) fail();
  await lockSkillPublication(tx, receipt, userId);
  const {
    rows: [active],
  } = await tx.query(
    `SELECT l.* FROM improvement_skill_lifecycle l JOIN improvement_skill_candidates c ON c."userId"=l."userId" AND c."issueId"=l."issueId" AND c."repoId"=l."repoId"
    WHERE l."userId"=$1 AND l."issueId"=$2 AND c."factoryTaskId"=$3 AND c."candidateId"=$4
    ORDER BY l."createdAt" DESC,l.id DESC LIMIT 1`,
    [userId, receipt.issueId, receipt.taskId, receipt.candidateId],
  );
  const {
    rows: [run],
  } = await tx.query(
    `SELECT r.*,m."receiptId",m."versionId",m.sha256,m."sessionId" AS "mountSessionId",m."mountedAt",
    s.receipt,p.purpose FROM agent_runs r
    JOIN improvement_skill_mounts m ON m."runId"=r.id AND m."userId"=r."userId" AND m."deviceId"=r."deviceId"
    JOIN improvement_skill_receipts s ON s.id=m."receiptId" AND s."runId"=r.id AND s."userId"=r."userId"
    JOIN improvement_skill_run_purposes p ON p."runId"=r.id AND p."userId"=r."userId" AND p."versionId"=m."versionId"
    JOIN improvement_skill_candidates c ON c."versionId"=m."versionId" AND c."issueId"=r."issueId" AND c."repoId"=r."deviceRepoId" AND c."agentId"=r."agentId"
    WHERE r.id=$1 AND r."userId"=$2 FOR SHARE OF r`,
    [runId, userId],
  );
  const {
    rows: [metadata],
  } = await tx.query(
    'SELECT * FROM improvement_skill_candidates WHERE "versionId"=$1 AND "userId"=$2',
    [proof.versionId, userId],
  );
  if (!metadata) fail();
  const version = await resolveSkillVersion(
    tx,
    userId,
    {
      issueId: metadata.issueId,
      agentId: metadata.agentId,
      deviceRepoId: metadata.repoId,
    },
    proof.versionId,
  );
  let errorCode: string | null = null;
  if (version.artifact.sha256 !== proof.sha256) fail();
  if (
    !active ||
    active.operation !== "activate" ||
    active.publicationId !== receipt.publicationId ||
    active.versionId !== proof.versionId
  )
    errorCode = "skill-withdrawn";
  else if (
    !run ||
    run.issueId !== receipt.issueId ||
    run.stopRequestedAt ||
    run.purpose !== "active" ||
    run.versionId !== proof.versionId ||
    run.sha256 !== proof.sha256 ||
    run.mountSessionId !== run.sessionId ||
    run.receipt?.id !== run.receiptId ||
    run.receipt?.artifact?.versionId !== proof.versionId ||
    run.receipt?.artifact?.sha256 !== proof.sha256 ||
    !run.startedAt ||
    new Date(run.startedAt).getTime() < Date.parse(receipt.publishedAt) ||
    new Date(run.mountedAt).getTime() < Date.parse(receipt.publishedAt)
  )
    errorCode = "skill-mount-unverified";
  else {
    const report = completionReport ?? run.report;
    if (
      (report as { verify?: { status?: string } })?.verify?.status ===
        "failed" ||
      run.status === "failed"
    )
      errorCode = "skill-run-failed";
  }
  return {
    command: "mikka-builtin:run-report:mounted-readback-v1",
    exitCode: errorCode ? 1 : 0,
    signal: null,
    timedOut: false,
    observedSha: receipt.candidate.sha,
    observedTarget: receipt.target,
    observedEnvironment: receipt.targetEnvironment,
    observedOperationId: receipt.verifiedTarget.operationId,
    observedReference: receipt.reference,
    errorCode,
    stdout: JSON.stringify({
      publicationId: receipt.publicationId,
      versionId: proof.versionId,
      sha256: proof.sha256,
      runId,
      mountReceiptId: run?.receiptId ?? null,
      errorCode,
    }),
    stderr: "",
    skill: { ...proof, runId, mountReceiptId: run?.receiptId ?? null },
    provider: undefined,
    health: undefined,
  };
}
