import { z } from "zod";
import type { PoolClient } from "pg";
import { candidateSchema, FactoryError } from "./contract";
import { digest } from "./evidence";

export const verifiedPublicationTarget = z
  .object({
    kind: z.enum(["local-artifact", "preview-deployment", "merge"]),
    operationId: z.string().min(1).max(2000),
    target: z.string().min(1).max(2000),
    environment: z.string().min(1).max(4000),
    repository: z.string().min(1).max(4000),
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    reference: z.string().min(1).max(2000),
    observedAt: z.iso.datetime(),
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
  if (v.kind === "preview-deployment") {
    let url: URL;
    try {
      url = new URL(v.reference);
    } catch {
      throw new FactoryError("factoryPublicationReceiptMismatch");
    }
    if (
      action !== "deploy_preview" ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new FactoryError("factoryPublicationReceiptMismatch");
  }
}

/** Called only inside the existing authorized/locked Factory transaction.
 * Expiry after consumption does not erase a historical publication. Revocation,
 * task cancellation, candidate replacement and missing verified receipts do block it.
 */
export async function readFactoryPublicationReceipt(
  tx: PoolClient,
  userId: string,
  taskId: string,
  candidateId: string,
) {
  const {
    rows: [p],
  } = await tx.query(
    `
    SELECT p.*,a.candidate,a.request AS "approvalRequest",a."revokedAt",t."issueId",c.sha,c.repository,c.environment,c.scope,
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
  if (
    !receipt.success ||
    !receipt.data.verifiedTarget ||
    digest(candidate) !== digest(p.candidate)
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
  return {
    version: 1 as const,
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
