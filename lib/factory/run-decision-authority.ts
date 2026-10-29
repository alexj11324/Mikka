import { createHash, verify, type KeyObject } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PERMISSION_DECISIONS } from "@mikka/protocol/agent-policy";
import {
  bindingSchema,
  FactoryError,
  publicationAction,
} from "./approval-contract";
import type {
  FactoryApprovalStore,
  FactoryAuthorize,
  FactoryTask,
} from "./approval-dependencies";
import {
  createFactoryApprovalGates,
  createFactoryApprovals,
  type PublicationAdapter,
} from "./approval";
import { readFactoryPublicationRequirements } from "./publication-requirements";
import { approvalEvidence, digest } from "./evidence";
import {
  verifiedFactoryDecision,
  type FactoryDecisionAuthority,
  type FactoryDecisionScope,
} from "./policy-authorization";
import {
  factoryDecisionExecution,
  factoryDecisionExecutionMatches,
} from "./decision-execution";

const id = z.string().min(1).max(2000);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const checkReceipt = z
  .object({
    stage: z.enum(["review", "verify"]),
    attemptId: z.uuid(),
    runId: z.uuid(),
    sessionId: id,
    eventId: z.uuid(),
  })
  .strict();
/** An authenticated review-transport attestation, not a model's permission.
 * No allow/ask/deny field is accepted here. Existing current policy supplies it. */
export const factoryRunReview = z
  .object({
    version: z.literal(1),
    purpose: z.literal("factory-publication-review"),
    credentialId: z.uuid(),
    ownerId: id,
    executionRunId: z.uuid(),
    executionSessionId: id,
    assignmentDigest: hash,
    instructionsDigest: hash,
    policyId: id,
    policyRevision: id,
    permissionAction: publicationAction,
    scopeDigest: hash,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    checks: z.array(checkReceipt).length(2),
    judgment: verifiedFactoryDecision.shape.judgment
      .unwrap()
      .extend({
        choice: z.literal("publish_current"),
        requestDigest: hash,
        execution: factoryDecisionExecution,
      })
      .strict(),
  })
  .strict();
export const factoryRunReviewEnvelope = z
  .object({
    issuer: id,
    keyId: id,
    payload: factoryRunReview,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
/** Existing runEventBatchSchema accepts data-* chunks. The server, not the
 * producer, assigns the row UUID; payload credentialId is the signed nonce. */
export const factoryRunReviewChunk = z
  .object({
    type: z.literal("data-factory-publication-review"),
    data: factoryRunReviewEnvelope,
  })
  .strict();

/** The transport may sign this exact domain-separated content. This library
 * only verifies it; it has no signer, private-key loading or issuance endpoint. */
export function factoryRunReviewSignatureInput(
  payload: z.infer<typeof factoryRunReview>,
  identity: { issuer: string; keyId: string },
) {
  return Buffer.from(
    `mikka.factory.publication-review.v1\0${digest({ issuer: id.parse(identity.issuer), keyId: id.parse(identity.keyId), payload: factoryRunReview.parse(payload) })}`,
  );
}

export interface FactoryExecutor {
  id: string;
  userId: string;
  issueId: string;
  deviceId: string;
  sessionId: string;
  status: string;
  leaseExpiresAt: Date;
  stopRequestedAt: Date | null;
  agentDefinition: unknown;
  kind: string;
  botId: string | null;
  startedAt?: Date | string | null;
  createdAt?: Date | string;
}
const currentPolicy = z
  .object({
    id,
    revision: id,
    ownerId: id,
    runId: z.uuid(),
    assignmentDigest: hash,
    scopeDigest: hash,
    permissionAction: publicationAction,
    readOnly: z.boolean(),
    decision: z.enum(PERMISSION_DECISIONS),
  })
  .strict();
export type FactoryCurrentPublicationPolicy = z.infer<typeof currentPolicy>;
/** Shared exact schema for the owned review issuer; no policy selection. */
export const factoryCurrentPublicationPolicy = currentPolicy;
export interface FactoryPublicationHost {
  /** Supplied by authenticated existing host transport, never request/model JSON. */
  ownerId: string;
  executionRunId: string;
  /** Hash of the already authenticated existing run token; never model input. */
  tokenHash: string;
  /** Actual shared transport's selected vision-capable model, from host config. */
  decisionModelId: string;
  /** Optional strict deployment: trusted host-review public keys. A host that
   * installs one requires a signed review envelope for every publication. The
   * default Warp-aligned deployment installs none; its review is advisory and
   * the registered policy alone authorizes a preview. No production identity is
   * installed here. */
  reviewKey?(issuer: string, keyId: string): KeyObject | undefined;
  /** Resolve/lock the real current registered publication policy using these DB
   * rows, including workspace membership/version/revocation. A network, desktop
   * or unknown-action ask fallback is not a publication registration. Main has
   * no such source yet: production must not install a synthetic implementation. */
  policy(
    tx: PoolClient,
    context: {
      task: FactoryTask;
      run: FactoryExecutor;
      scope: FactoryDecisionScope;
    },
  ): Promise<FactoryCurrentPublicationPolicy | null>;
  /** Read/verify the EXISTING policy's exact ask confirmation and retain its
   * authorization locks. No new approval UI/table/question is introduced. */
  confirmation?(
    tx: PoolClient,
    context: {
      credentialId: string;
      scopeDigest: string;
      policy: FactoryCurrentPublicationPolicy;
    },
  ): Promise<
    z.infer<typeof verifiedFactoryDecision>["confirmation"] | undefined
  >;
}
function fail(code: string): never {
  throw new FactoryError(code);
}
const bindingOf = (t: FactoryTask) => ({
  taskId: t.id,
  issueId: t.issueId,
  attemptId: t.attemptId,
  revision: t.revision,
  candidateId: t.candidateId,
});

/** Consume the producer's committed check results, not a fabricated running
 * projection passed to #193's running-only independence predicate. Trusted #192
 * composition must install #193 for pass AND fail before these events exist. */
async function passedChecks(tx: PoolClient, task: FactoryTask) {
  const identity = task as FactoryTask & {
    botId: string | null;
    sourceEventId: string;
  };
  const receipts: z.infer<typeof checkReceipt>[] = [];
  for (const stage of ["review", "verify"] as const) {
    const {
      rows: [a],
    } = await tx.query(
      'SELECT * FROM factory_attempts WHERE "taskId"=$1 AND "candidateId"=$2 AND stage=$3 ORDER BY position DESC LIMIT 1',
      [task.id, task.candidateId, stage],
    );
    if (!a || a.status !== "passed" || !a.runId || !a.sessionId)
      fail("factoryPolicyCheckReceiptRequired");
    const { rows } = await tx.query(
      `SELECT "eventId",request,result FROM factory_events WHERE "taskId"=$1 AND request->'change'->>'action'='finish' AND request->'change'->>'status'='passed' AND request->'binding'->>'attemptId'=$2 LIMIT 2`,
      [task.id, a.id],
    );
    if (rows.length !== 1) fail("factoryPolicyCheckReceiptRequired");
    const e = rows[0],
      b = bindingSchema.safeParse(e.request?.binding),
      t = e.result?.task;
    const saved = e.result?.attempts?.find(
      (v: Record<string, unknown>) => v.id === a.id,
    );
    if (
      !b.success ||
      b.data.taskId !== task.id ||
      b.data.issueId !== task.issueId ||
      b.data.candidateId !== task.candidateId ||
      t?.id !== task.id ||
      t.userId !== task.userId ||
      t.issueId !== task.issueId ||
      t.botId !== identity.botId ||
      t.sourceEventId !== identity.sourceEventId ||
      t.candidateId !== task.candidateId ||
      t.attemptId !== a.id ||
      t.stage !== stage ||
      t.status !== "passed" ||
      t.revision !== b.data.revision + 1 ||
      saved?.status !== "passed" ||
      saved.stage !== stage ||
      saved.candidateId !== task.candidateId ||
      saved.runId !== a.runId ||
      saved.sessionId !== a.sessionId ||
      digest(saved.evidence) !== digest(a.evidence) ||
      digest(saved.output) !== digest(a.output)
    )
      fail("factoryPolicyCheckReceiptRequired");
    receipts.push(
      checkReceipt.parse({
        stage,
        attemptId: a.id,
        runId: a.runId,
        sessionId: a.sessionId,
        eventId: e.eventId,
      }),
    );
  }
  return receipts;
}
/** The issuer and verifier consume the same canonical committed receipts. */
export { passedChecks as readFactoryPassedCheckReceipts };

/** Same transaction guard for worker evidence reads and publication I/O.
 * Called after the existing task/issue locks; current token/STOP/lease/device
 * state is rechecked rather than trusting an earlier authentication result. */
export async function lockFactoryPublicationExecutor(
  tx: PoolClient,
  host: Pick<
    FactoryPublicationHost,
    "ownerId" | "executionRunId" | "tokenHash"
  >,
  issueId: string,
): Promise<FactoryExecutor> {
  const {
    rows: [run],
  } = await tx.query<FactoryExecutor>(
    `SELECT r.* FROM agent_runs r JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId" AND d.enabled=true JOIN run_tokens k ON k."runId"=r.id AND k."userId"=r."userId" WHERE r.id=$1 AND r."userId"=$2 AND r."issueId"=$3 AND r.status IN ('preparing','running','waiting_input','finishing') AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">clock_timestamp() AND k."tokenHash"=$4 AND k."revokedAt" IS NULL AND k."expiresAt">clock_timestamp() FOR SHARE OF r,k,d`,
    [host.executionRunId, host.ownerId, issueId, host.tokenHash],
  );
  if (!run) fail("factoryPolicyDecisionRevoked");
  return run;
}

/** Concrete DB/crypto consumer on the existing worker/run-chunk transport. Every
 * call joins the caller's task transaction; no cached allow, provider I/O,
 * model invocation, private-key handling or online credential issuance. */
export function createFactoryRunDecisionAuthority(
  store: Pick<FactoryApprovalStore, "lockTask">,
  host: FactoryPublicationHost,
): FactoryDecisionAuthority {
  return {
    async verify(tx, credentialId, expected) {
      if (
        !z.uuid().safeParse(credentialId).success ||
        host.ownerId !== expected.ownerId ||
        !z.uuid().safeParse(host.executionRunId).success ||
        !hash.safeParse(host.tokenHash).success
      )
        fail("factoryPolicyDecisionMismatch");
      const task = await store.lockTask(
        tx,
        host.ownerId,
        expected.binding.taskId,
      );
      if (
        task.candidateId !== expected.binding.candidateId ||
        task.issueId !== expected.binding.issueId ||
        ["cancelled", "revoked"].includes(task.status)
      )
        fail("factoryPolicyDecisionRevoked");
      const run = await lockFactoryPublicationExecutor(tx, host, task.issueId);
      // This application opens pull requests; it never merges. Repository
      // protection and repository permissions are the enforced merge control,
      // so no credential may authorize a merge here.
      if (expected.action === "merge") fail("factoryPolicyDenied");
      const identity = task as FactoryTask & {
        botId: string | null;
        sourceEventId: string;
      };
      if (
        !z.uuid().nullable().safeParse(identity.botId).success ||
        !z.uuid().safeParse(identity.sourceEventId).success ||
        run.botId !== identity.botId
      )
        fail("factoryPolicyDecisionMismatch");
      // Existing acceptance runs are mechanically read-only (ADR 0046).
      if (run.kind === "acceptance") fail("factoryPolicyDenied");
      const {
        rows: [clock],
      } = await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = clock.now.getTime();
      if (
        !run.agentDefinition ||
        !run.deviceId ||
        !run.sessionId ||
        run.stopRequestedAt ||
        !["preparing", "running", "waiting_input", "finishing"].includes(
          run.status,
        ) ||
        !run.leaseExpiresAt ||
        new Date(run.leaseExpiresAt).getTime() <= now
      )
        fail("factoryPolicyDecisionRevoked");
      // A host that installs a trusted review key runs the strict deployment:
      // the signed review envelope is the decision credential. The default,
      // Warp-aligned deployment installs no crypto issuer, so its review is
      // advisory and the registered policy alone decides. Both paths enforce
      // the same task/run/lease/check fences.
      const signedKey = host.reviewKey?.bind(host);
      const attestation: "signed" | "advisory" = signedKey
        ? "signed"
        : "advisory";
      // Irreversible effects stay behind the strict deployment; opening a
      // preview is the only effect an advisory review may accompany.
      if (!signedKey && expected.action !== "deploy_preview")
        fail("factoryPolicyAttestationRequired");
      const scopeDigest = digest(expected);
      let body: z.infer<typeof factoryRunReview> | undefined;
      let envelope: z.infer<typeof factoryRunReviewEnvelope> | undefined;
      let signature: Buffer | undefined;
      let keyFingerprint: string | undefined;
      let receiptId = credentialId;
      // Advisory grants use one host-owned issuer name for ledger uniqueness;
      // the credential id is only an idempotency key, never a signed nonce.
      let issuer = "factory-host-policy";
      if (signedKey) {
        const {
          rows: [source],
        } = await tx.query<{ id: string; chunk: unknown; createdAt: Date }>(
          `SELECT id,chunk,"createdAt" FROM run_chunks WHERE "runId"=$1 AND chunk->>'type'='data-factory-publication-review' AND chunk->'data'->'payload'->>'credentialId'=$2 ORDER BY seq,"createdAt",id LIMIT 1 FOR SHARE`,
          [run.id, credentialId],
        );
        if (!source) fail("factoryPolicyDecisionUnavailable");
        const parsed = factoryRunReviewChunk.safeParse(source.chunk);
        if (!parsed.success) fail("factoryPolicyDecisionInvalid");
        envelope = parsed.data.data;
        body = envelope.payload;
        issuer = envelope.issuer;
        const key = signedKey(envelope.issuer, envelope.keyId);
        if (
          !key ||
          key.type !== "public" ||
          key.asymmetricKeyType !== "ed25519"
        )
          fail("factoryPolicyDecisionUnavailable");
        keyFingerprint = createHash("sha256")
          .update(key.export({ format: "der", type: "spki" }))
          .digest("hex");
        signature = Buffer.from(envelope.signature, "base64url");
        if (
          signature.length !== 64 ||
          signature.toString("base64url") !== envelope.signature ||
          !verify(
            null,
            factoryRunReviewSignatureInput(body, envelope),
            key,
            signature,
          )
        )
          fail("factoryPolicyDecisionInvalid");
        if (
          body.credentialId !== credentialId ||
          body.ownerId !== host.ownerId ||
          body.executionRunId !== run.id ||
          body.executionSessionId !== run.sessionId ||
          body.assignmentDigest !== digest(run.agentDefinition) ||
          body.instructionsDigest !==
            digest(
              await readFactoryPublicationRequirements(
                tx,
                task,
                run.agentDefinition,
              ),
            ) ||
          body.scopeDigest !== scopeDigest ||
          body.permissionAction !== expected.action ||
          !run.startedAt ||
          new Date(body.issuedAt).getTime() <
            new Date(run.startedAt).getTime() ||
          new Date(body.issuedAt).getTime() > source.createdAt.getTime() ||
          new Date(body.issuedAt).getTime() > now ||
          new Date(body.expiresAt).getTime() <= now ||
          new Date(body.expiresAt).getTime() <
            new Date(expected.expiresAt).getTime()
        )
          fail("factoryPolicyDecisionMismatch");
        if (
          body.judgment.receiptId !== body.judgment.execution.executionId ||
          body.judgment.model !== body.judgment.execution.modelId ||
          !factoryDecisionExecutionMatches(body.judgment.execution, {
            modelId: host.decisionModelId,
            requestDigest: body.judgment.requestDigest,
            imageDigests: body.judgment.imageDigests,
            requiresVisual: body.judgment.visualInputRequired,
            scopeDigest: body.scopeDigest,
            evidenceDigest: expected.evidenceDigest,
            startedAfter: new Date(run.startedAt!).toISOString(),
            observedAt: body.issuedAt,
          })
        )
          fail("factoryPolicyModelEvidenceUnavailable");
        receiptId = source.id;
      }
      const passed = await passedChecks(tx, task);
      const current = await approvalEvidence(tx, task);
      if (
        current.evidenceDigest !== expected.evidenceDigest ||
        digest(current.manifest.candidate) !== digest(expected.candidate) ||
        (body !== undefined && digest(body.checks) !== digest(passed))
      )
        fail("factoryPolicyCheckReceiptRequired");
      const {
        rows: [grant],
      } = await tx.query(
        'SELECT * FROM factory_approvals WHERE "decisionCredentialId"=$1 AND "decisionEvidence"->>\'issuer\'=$2 FOR SHARE',
        [credentialId, issuer],
      );
      if (grant?.revokedAt) fail("factoryPolicyDecisionRevoked");
      if (
        task.stage === "approval" &&
        ["pending", "waiting"].includes(task.status)
      ) {
        if (digest(bindingOf(task)) !== digest(expected.binding))
          fail("factoryPolicyDecisionMismatch");
      } else if (
        !grant ||
        grant.taskId !== task.id ||
        digest(grant.decisionScope) !== digest(expected) ||
        task.stage !== "publish" ||
        task.attemptId !== grant.publishAttemptId ||
        !(
          (task.status === "pending" &&
            task.revision === grant.publishRevision) ||
          (task.status === "passed" &&
            task.revision === grant.publishRevision + 1)
        )
      )
        fail("factoryPolicyDecisionMismatch");
      const policyRaw = await host.policy(tx, { task, run, scope: expected });
      const policyResult = currentPolicy.safeParse(policyRaw);
      if (!policyResult.success) fail("factoryPolicyDecisionUnavailable");
      const policy = policyResult.data;
      if (
        policy.ownerId !== host.ownerId ||
        policy.runId !== run.id ||
        policy.assignmentDigest !== digest(run.agentDefinition) ||
        policy.scopeDigest !== scopeDigest ||
        policy.permissionAction !== expected.action ||
        (body !== undefined &&
          (policy.id !== body.policyId ||
            policy.revision !== body.policyRevision))
      )
        fail("factoryPolicyDecisionRevoked");
      const decision = policy.readOnly ? "deny" : policy.decision;
      const confirmation =
        decision === "ask"
          ? await host.confirmation?.(tx, {
              credentialId,
              scopeDigest,
              policy,
            })
          : undefined;
      // Advisory evidence must stay deterministic: the verify result is stored
      // with the grant and compared byte-for-byte at the publish boundary.
      const issuedAt =
        body?.issuedAt ??
        (run.startedAt ? new Date(run.startedAt).toISOString() : undefined);
      if (!issuedAt) fail("factoryPolicyDecisionUnavailable");
      return {
        version: 1,
        credentialId,
        issuer,
        policyId: policy.id,
        policyRevision: policy.revision,
        permissionAction: policy.permissionAction,
        ownerId: host.ownerId,
        scopeDigest,
        decision,
        issuedAt,
        expiresAt: body?.expiresAt ?? expected.expiresAt,
        verification: {
          receiptId,
          attestation,
          ...(signature
            ? {
                signatureDigest: createHash("sha256")
                  .update(signature)
                  .digest("hex"),
              }
            : {}),
          ...(body && envelope && keyFingerprint
            ? {
                runBinding: {
                  runId: run.id,
                  sessionId: run.sessionId,
                  assignmentDigest: body.assignmentDigest,
                  checkReceiptsDigest: digest(body.checks),
                  reviewDigest: digest(envelope),
                  keyId: envelope.keyId,
                  keyFingerprint,
                },
              }
            : {}),
        },
        ...(body ? { judgment: body.judgment } : {}),
        ...(confirmation ? { confirmation } : {}),
      };
    },
  };
}

/** Minimal backend composition. The host supplies its authenticated run context,
 * real policy source and public review keys. createStore uses #192's existing
 * store (botId THIRD, lifecycle FOURTH), retaining all other owners' gates and
 * #193 independence. No application route/flag/issuer is registered here. */
export function createFactoryPublicationHost<S extends FactoryApprovalStore>(
  pool: Pool,
  authorize: FactoryAuthorize,
  createStore: (gates: ReturnType<typeof createFactoryApprovalGates>) => S,
  host: FactoryPublicationHost,
  adapters: PublicationAdapter[] = [],
) {
  let store: S | undefined;
  const authority = createFactoryRunDecisionAuthority(
    {
      lockTask: (...args) => {
        if (!store) fail("factoryPolicyDecisionUnavailable");
        return store.lockTask(...args);
      },
    },
    host,
  );
  store = createStore(createFactoryApprovalGates(authority));
  return {
    store,
    authority,
    approvals: createFactoryApprovals(
      pool,
      authorize,
      store,
      adapters,
      authority,
    ),
  };
}
