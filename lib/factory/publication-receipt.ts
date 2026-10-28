import { z } from "zod";
import type { PoolClient } from "pg";
import { candidateSchema, FactoryError } from "./approval-contract";
import { digest } from "./evidence";
import { publicationBindingHash } from "./publication-operation";
import { approvalRequest, publicationRequest } from "./approval-contract";

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

export const verifiedPublicationTarget = z
  .object({
    kind: z.enum([
      "local-artifact",
      "preview-deployment",
      "production-deployment",
      "merge",
    ]),
    operationId: z.string().min(1).max(2000),
    target: z.string().min(1).max(2000),
    environment: z.string().min(1).max(4000),
    repository: z.string().min(1).max(4000),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    reference: z.string().min(1).max(2000),
    observedAt: z.iso.datetime(),
    provider: provider.optional(),
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
) {
  const v = receipt.verifiedTarget;
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

/** Called only inside the existing authorized/locked Factory transaction.
 * Expiry after consumption does not erase a historical publication. Revocation,
 * task cancellation, candidate replacement and missing verified receipts do block it.
 */
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
    SELECT p.*,a.candidate,a.request AS "approvalRequest",a.action AS "approvalAction",a.target AS "approvalTarget",a."publishAttemptId",a."publishRevision",a."humanSessionId",a."revokedAt",t."issueId",c.sha,c.repository,c.environment,c.scope,
      s.status AS "publishStatus",s.output AS "publishOutput",s."finishedAt" AS "publishFinishedAt"
    FROM factory_publications p
    JOIN factory_approvals a ON a.id=p."approvalId" AND a."taskId"=p."taskId" AND a."candidateId"=p."candidateId" AND a."userId"=$1
    JOIN factory_tasks t ON t.id=p."taskId" AND t."userId"=$1 AND t."candidateId"=p."candidateId" AND t.status NOT IN ('cancelled','revoked')
    JOIN factory_candidates c ON c.id=p."candidateId" AND c."taskId"=p."taskId"
    JOIN factory_attempts s ON s.id=a."publishAttemptId" AND s."taskId"=p."taskId" AND s.stage='publish' AND s."candidateId"=p."candidateId"
    WHERE p."taskId"=$2 AND p."candidateId"=$3 AND p.status='succeeded'
    ORDER BY p."finishedAt" DESC LIMIT 1`,
    [userId, taskId, candidateId],
  );
  if (
    !p ||
    p.revokedAt ||
    p.publishStatus !== "passed" ||
    p.publishOutput?.publicationId !== p.id ||
    p.publishOutput?.approvalId !== p.approvalId ||
    !p.finishedAt ||
    !p.publishFinishedAt ||
    !p.request.targetEnvironment ||
    p.request.targetEnvironment !== p.approvalRequest.targetEnvironment
  )
    throw new FactoryError("factoryPublicationReceiptRequired");
  const candidate = candidateSchema.parse({
    sha: p.sha,
    repository: p.repository,
    environment: p.environment,
    scope: p.scope,
  });
  const receipt = publicationAdapterReceipt.safeParse(p.receipt);
  const request = publicationRequest.safeParse(p.request),
    approval = approvalRequest.safeParse(p.approvalRequest);
  if (
    !receipt.success ||
    !request.success ||
    !approval.success ||
    p.action !== p.approvalAction ||
    p.target !== p.approvalTarget ||
    request.data.action !== p.action ||
    approval.data.action !== p.action ||
    request.data.target !== p.target ||
    approval.data.target !== p.target ||
    request.data.approvalId !== p.approvalId ||
    request.data.eventId !== p.eventId ||
    request.data.binding.taskId !== taskId ||
    request.data.binding.issueId !== p.issueId ||
    request.data.binding.candidateId !== candidateId ||
    request.data.binding.attemptId !== p.publishAttemptId ||
    request.data.binding.revision !== p.publishRevision ||
    approval.data.binding.taskId !== taskId ||
    approval.data.binding.issueId !== p.issueId ||
    approval.data.binding.candidateId !== candidateId ||
    digest(candidate) !== digest(approval.data.candidate) ||
    !receipt.data.verifiedTarget ||
    digest(candidate) !== digest(p.candidate) ||
    new Date(receipt.data.verifiedTarget.observedAt).getTime() <
      p.createdAt.getTime() ||
    new Date(receipt.data.verifiedTarget.observedAt).getTime() >
      p.publishFinishedAt.getTime()
  )
    throw new FactoryError("factoryPublicationReceiptRequired");
  assertPublicationTarget(
    receipt.data,
    candidate,
    p.action,
    p.target,
    p.request.targetEnvironment,
    p.id,
  );
  if (
    receipt.data.verifiedTarget.provider?.bindingHash !== undefined &&
    receipt.data.verifiedTarget.provider.bindingHash !==
      publicationBindingHash({
        idempotencyKey: p.id,
        candidate,
        authorization: {
          approvalId: p.approvalId,
          ownerId: userId,
          humanSessionId: p.humanSessionId,
          expiresAt: p.approvalRequest.expiresAt,
          binding: p.request.binding,
          eventId: p.request.eventId,
          action: p.action,
          target: p.target,
          targetEnvironment: p.request.targetEnvironment,
        },
      })
  )
    throw new FactoryError("factoryPublicationReceiptRequired");
  return {
    version: 2 as const,
    publicationId: p.id as string,
    approvalId: p.approvalId as string,
    taskId,
    issueId: p.issueId as string,
    candidateId,
    candidate,
    action: p.action as "deploy_preview" | "deploy_production" | "merge",
    target: p.target as string,
    targetEnvironment: p.request.targetEnvironment as string,
    publishedAt: (p.publishFinishedAt as Date).toISOString(),
    reference: receipt.data.reference,
    verifiedTarget: receipt.data.verifiedTarget,
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
