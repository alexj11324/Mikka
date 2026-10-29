import type { PoolClient } from "pg";
import { z } from "zod";
import { PERMISSION_DECISIONS } from "@mikka/protocol/agent-policy";
import {
  bindingSchema,
  candidateSchema,
  publicationAction,
  FactoryError,
} from "./approval-contract";
import { digest } from "./evidence";
import { factoryDecisionExecution } from "./decision-execution";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(2000);
/** A trusted host builds this from locked task/candidate and actual evidence.
 * Model output and browser JSON cannot choose the owner or visual-input list. */
export const factoryDecisionScope = z
  .object({
    ownerId: identifier,
    binding: bindingSchema,
    candidate: candidateSchema,
    action: publicationAction,
    target: identifier,
    targetEnvironment: identifier,
    evidenceDigest: hash,
    visualEvidenceDigests: z.array(hash).max(100),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type FactoryDecisionScope = z.infer<typeof factoryDecisionScope>;

export const verifiedFactoryDecision = z
  .object({
    version: z.literal(1),
    credentialId: identifier,
    issuer: identifier,
    policyId: identifier,
    policyRevision: identifier,
    // An existing registered publication action; never network/git_push or an
    // unknown-action fallback that happened to say ask.
    permissionAction: publicationAction,
    ownerId: identifier,
    scopeDigest: hash,
    decision: z.enum(PERMISSION_DECISIONS),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    verification: z
      .object({
        receiptId: identifier,
        signatureDigest: hash,
        runBinding: z
          .object({
            runId: z.uuid(),
            sessionId: identifier,
            assignmentDigest: hash,
            checkReceiptsDigest: hash,
            reviewDigest: hash,
            keyId: identifier,
            keyFingerprint: hash,
          })
          .strict()
          .optional(),
      })
      .strict(),
    // Recorded by the host from an actual vision-capable model invocation, never
    // accepted as a model's assertion about its own capabilities or input.
    judgment: z
      .object({
        receiptId: identifier,
        model: identifier,
        capability: z.literal("vision"),
        visualInputRequired: z.boolean(),
        scopeDigest: hash,
        evidenceDigest: hash,
        imageDigests: z.array(hash).max(100),
        choice: z.literal("publish_current").optional(),
        requestDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        execution: factoryDecisionExecution.optional(),
      })
      .strict(),
    confirmation: z
      .object({
        decisionId: identifier,
        ownerId: identifier,
        sessionId: identifier,
        scopeDigest: hash,
        confirmedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FactoryVerifiedPolicyDecision = z.infer<
  typeof verifiedFactoryDecision
>;

/** Required integration seam, NOT an implemented Factory deploy credential.
 * The existing policy authority must authenticate its signature/provenance,
 * current registered action/policy revision, revocation, owner/workspace/run
 * STOP/lease fences when applicable and a live decision-bound ask confirmation.
 * Retain the existing authority/confirmation locks through the caller transaction;
 * a detached model answer or an unlocked cached policy snapshot is not a lease.
 * Called again at every execution/reconciliation boundary; never cache allow.
 * Do not implement this with an LLM's JSON result or ordinary git/network grants.
 */
export interface FactoryDecisionAuthority {
  verify(
    tx: PoolClient,
    credentialId: string,
    expected: FactoryDecisionScope,
  ): Promise<unknown>;
}

/** Enforces an already made model judgment and existing policy decision.
 * Performs no business classification, policy selection, signing or provider I/O.
 * Only ask needs a human confirmation; missing authority is unavailable, not ask.
 */
export async function authorizeFactoryDecision(
  tx: PoolClient,
  authority: FactoryDecisionAuthority | undefined,
  credentialId: string,
  expectedInput: FactoryDecisionScope,
): Promise<FactoryVerifiedPolicyDecision> {
  if (!authority) throw new FactoryError("factoryPolicyDecisionUnavailable");
  const scope = factoryDecisionScope.safeParse(expectedInput);
  if (!scope.success) throw new FactoryError("factoryPolicyDecisionInvalid");
  const expected = scope.data;
  if (!identifier.safeParse(credentialId).success)
    throw new FactoryError("factoryPolicyDecisionInvalid");
  let raw: unknown;
  try {
    raw = await authority.verify(tx, credentialId, expected);
  } catch (error) {
    if (
      error instanceof FactoryError &&
      [
        "factoryPolicyDenied",
        "factoryPolicyDecisionRevoked",
        "factoryPolicyDecisionMismatch",
        "factoryPolicyDecisionExpired",
        "factoryPolicyDecisionInvalid",
        "factoryPolicyCheckReceiptRequired",
        "factoryPolicyDecisionUnavailable",
      ].includes(error.code)
    )
      throw error;
    // Do not expose credential values or private upstream errors.
    throw new FactoryError("factoryPolicyDecisionUnavailable");
  }
  const parsed = verifiedFactoryDecision.safeParse(raw);
  if (!parsed.success) throw new FactoryError("factoryPolicyDecisionInvalid");
  const d = parsed.data;
  const scopeDigest = digest(expected);
  if (
    d.credentialId !== credentialId ||
    d.permissionAction !== expected.action ||
    d.ownerId !== expected.ownerId ||
    d.scopeDigest !== scopeDigest ||
    d.judgment.scopeDigest !== scopeDigest ||
    d.judgment.evidenceDigest !== expected.evidenceDigest ||
    digest(d.judgment.imageDigests) !==
      digest(expected.visualEvidenceDigests) ||
    (d.judgment.visualInputRequired && d.judgment.imageDigests.length === 0)
  )
    throw new FactoryError("factoryPolicyDecisionMismatch");
  const {
    rows: [clock],
  } = await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  if (!clock?.now) throw new FactoryError("factoryPolicyDecisionUnavailable");
  const now = clock.now.getTime();
  const requestedExpiry = new Date(expected.expiresAt).getTime();
  if (
    new Date(d.issuedAt).getTime() > now ||
    new Date(d.expiresAt).getTime() <= now ||
    requestedExpiry <= now ||
    requestedExpiry > now + 24 * 60 * 60 * 1000 ||
    requestedExpiry > new Date(d.expiresAt).getTime()
  )
    throw new FactoryError("factoryPolicyDecisionExpired");
  if (d.decision === "deny") throw new FactoryError("factoryPolicyDenied");
  if (d.decision === "ask") {
    const c = d.confirmation;
    if (!c) throw new FactoryError("factoryPolicyConfirmationRequired");
    if (
      c.decisionId !== d.credentialId ||
      c.ownerId !== expected.ownerId ||
      c.scopeDigest !== scopeDigest ||
      new Date(c.confirmedAt).getTime() < new Date(d.issuedAt).getTime() ||
      new Date(c.confirmedAt).getTime() > now ||
      new Date(c.expiresAt).getTime() < requestedExpiry
    )
      throw new FactoryError("factoryPolicyConfirmationInvalid");
  }
  return d;
}
