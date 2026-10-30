import { z } from "zod";
import type { PoolClient } from "pg";
import { candidateSchema, FactoryError } from "./approval-contract";

import { publicationAction } from "./approval-contract";

const provider = z
  .object({
    version: z.literal(2),
    name: z.literal("vercel"),
    teamId: z.string().regex(/^team_[\w]+$/),
    projectId: z.string().regex(/^prj_[\w]+$/),
    deploymentId: z.string().regex(/^dpl_[\w]+$/),
    environment: z.enum(["preview", "production"]),
    publicationId: z.uuid(),
    bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const skillActivationProof = z
  .object({
    version: z.literal(1),
    publicationId: z.uuid(),
    bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
    versionId: z.uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    proposalId: z.uuid(),
    evaluationId: z.uuid(),
  })
  .strict();
export type SkillActivationProof = z.infer<typeof skillActivationProof>;

export const verifiedPublicationTarget = z
  .object({
    kind: z.enum([
      "local-artifact",
      "preview-deployment",
      "production-deployment",
      "merge",
      "skill-activation",
    ]),
    operationId: z.string().min(1).max(2000),
    target: z.string().min(1).max(2000),
    environment: z.string().min(1).max(4000),
    repository: z.string().min(1).max(4000),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    reference: z.string().min(1).max(2000),
    observedAt: z.iso.datetime(),
    provider: provider.optional(),
    skill: skillActivationProof.optional(),
  })
  .strict();
export const publicationAdapterReceipt = z
  .object({
    reference: z.string().min(1).max(2000),
    verifiedTarget: verifiedPublicationTarget,
  })
  .strict();
export type PublicationAdapterReceipt = z.infer<
  typeof publicationAdapterReceipt
>;

export function assertPublicationTarget(
  receipt: PublicationAdapterReceipt,
  candidate: z.infer<typeof candidateSchema>,
  action: string,
  target: string,
  targetEnvironment: string,
  publicationId?: string,
  expectedBindingHash?: string,
) {
  const v = receipt.verifiedTarget;
  if (
    (action === "activate_skill") !== (v.kind === "skill-activation") ||
    (action !== "activate_skill" && v.skill !== undefined)
  )
    throw new FactoryError("factoryPublicationReceiptMismatch");
  if (action === "activate_skill") {
    const proof = skillActivationProof.safeParse(v.skill);
    if (
      !proof.success ||
      !publicationId ||
      v.operationId !== publicationId ||
      proof.data.publicationId !== publicationId ||
      !expectedBindingHash ||
      proof.data.bindingHash !== expectedBindingHash ||
      target !== "mikka-builtin:run-report" ||
      !["preview", "production"].includes(targetEnvironment)
    )
      throw new FactoryError("factoryPublicationReceiptMismatch");
  }

  if (
    v.target !== target ||
    !targetEnvironment ||
    v.environment !== targetEnvironment ||
    v.repository !== candidate.repository ||
    v.sha !== candidate.sha ||
    v.reference !== receipt.reference ||
    (action === "merge" ? v.kind !== "merge" : v.kind === "merge")
  )
    throw new FactoryError("factoryPublicationReceiptMismatch");
  if (
    v.kind === "local-artifact" &&
    (action !== "deploy_preview" ||
      !/^local(?:-|$)/.test(v.environment) ||
      !v.reference.startsWith(`local-artifact:${v.operationId}:sha256:`) ||
      (publicationId && v.operationId !== publicationId))
  )
    throw new FactoryError("factoryPublicationReceiptMismatch");
  if (v.kind === "preview-deployment" || v.kind === "production-deployment") {
    let url: URL;
    try {
      url = new URL(v.reference);
    } catch {
      throw new FactoryError("factoryPublicationReceiptMismatch");
    }
    if (
      action !==
        (v.kind === "production-deployment"
          ? "deploy_production"
          : "deploy_preview") ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new FactoryError("factoryPublicationReceiptMismatch");
  }
  if (
    v.kind === "production-deployment" ||
    target.startsWith("vercel:") ||
    v.provider
  ) {
    const p = v.provider;
    if (
      !p ||
      v.kind !== `${p.environment}-deployment` ||
      v.environment !== p.environment ||
      v.target !== `vercel:${p.teamId}:${p.projectId}:${p.environment}` ||
      v.operationId !== p.deploymentId ||
      (publicationId && p.publicationId !== publicationId) ||
      !/^https:\/\/[a-z0-9][a-z0-9.-]*\.vercel\.app$/.test(v.reference) ||
      v.reference.includes("-git-")
    )
      throw new FactoryError("factoryPublicationReceiptMismatch");
  }
}

/** Read an already verified publication inside the caller's authorized transaction.
 * Authorization proofs are verified at write time; historical reads check only
 * succeeded, not cancelled, current candidate and not revoked. */
export async function readFactoryPublicationReceiptV2(
  tx: PoolClient,
  userId: string,
  taskId: string,
  candidateId: string,
) {
  const {
    rows: [p],
  } = await tx.query(
    `
    SELECT p.*,a.candidate,t."issueId"
    FROM factory_publications p
    JOIN factory_approvals a ON a.id=p."approvalId" AND a."taskId"=p."taskId" AND a."userId"=$1 AND a."revokedAt" IS NULL
    JOIN factory_tasks t ON t.id=p."taskId" AND t."userId"=$1
      AND t.status NOT IN ('cancelled','revoked') AND t."candidateId"=p."candidateId"
    WHERE p."taskId"=$2 AND p."candidateId"=$3 AND p.status='succeeded'
    ORDER BY p."finishedAt" DESC LIMIT 1`,
    [userId, taskId, candidateId],
  );
  if (!p?.receipt) throw new FactoryError("factoryPublicationReceiptRequired");
  const receipt = p.receipt as PublicationAdapterReceipt;
  return {
    version: 2 as const,
    publicationId: p.id as string,
    approvalId: p.approvalId as string,
    taskId,
    issueId: p.issueId as string,
    candidateId,
    candidate: p.candidate as z.infer<typeof candidateSchema>,
    action: p.action as z.infer<typeof publicationAction>,
    target: p.target as string,
    targetEnvironment: p.request.targetEnvironment as string,
    publishedAt: (p.finishedAt as Date).toISOString(),
    reference: receipt.reference,
    verifiedTarget: receipt.verifiedTarget,
  };
}

export type FactoryPublicationReceiptV2 = Awaited<
  ReturnType<typeof readFactoryPublicationReceiptV2>
>;

/** Legacy monitor callers must explicitly adopt V2 before accepting production. */
export async function readFactoryPublicationReceipt(
  tx: PoolClient,
  userId: string,
  taskId: string,
  candidateId: string,
) {
  const r = await readFactoryPublicationReceiptV2(
    tx,
    userId,
    taskId,
    candidateId,
  );
  if (
    r.action === "deploy_production" ||
    r.verifiedTarget.kind === "production-deployment"
  )
    throw new FactoryError("factoryPublicationReceiptRequired");
  return {
    ...r,
    version: 1 as const,
    action: r.action,
    verifiedTarget: { ...r.verifiedTarget, kind: r.verifiedTarget.kind },
  };
}
