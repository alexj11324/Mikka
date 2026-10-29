import "server-only";
import {
  createHash,
  createPublicKey,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { FactoryError } from "./approval-contract";
import type {
  FactoryApprovalStore,
  FactoryTask,
} from "./approval-dependencies";
import {
  factoryDecisionScope,
  type FactoryDecisionScope,
} from "./policy-authorization";
import {
  approvalEvidence,
  digest,
  readFactoryArtifact,
  redactArtifact,
} from "./evidence";
import { readFactoryPublicationRequirements } from "./publication-requirements";
import { factoryDecisionExecutionMatches } from "./decision-execution";
import {
  readFactoryPublicationInvocation,
  type FactoryPublicationInvocation,
} from "./publication-invocation";
import {
  factoryCurrentPublicationPolicy,
  factoryRunReview,
  factoryRunReviewChunk,
  factoryRunReviewSignatureInput,
  lockFactoryPublicationExecutor,
  readFactoryPassedCheckReceipts,
  type FactoryPublicationHost,
} from "./run-decision-authority";

/** Server dependency only. Never a tool argument, serialized private key,
 * credential loader, environment fallback or new signing identity. The actual
 * approved host must supply an existing authorized signing key and matching
 * live public-key binding. Nothing configures one in this batch. */
export interface FactoryRunReviewSigner {
  issuer: string;
  keyId: string;
  privateKey(): KeyObject | undefined;
}
const binding = (task: FactoryTask) => ({
  taskId: task.id,
  issueId: task.issueId,
  attemptId: task.attemptId,
  revision: task.revision,
  candidateId: task.candidateId,
});
function fail(code: string): never {
  throw new FactoryError(code);
}
const fingerprint = (key: KeyObject) =>
  createHash("sha256")
    .update(key.export({ format: "der", type: "spki" }))
    .digest("hex");

/** Concrete issuer of a semantic review attestation, NOT an execution grant.
 * Joins the existing locked transaction. Reads current canonical state/policy,
 * checks the actual model result and signs in memory; no provider/model call,
 * new table, row deletion, private-key loading or permission registration.
 * The caller appends the returned chunk through the EXISTING run event writer,
 * which owns sequence/row UUID. This function never competes for that sequence.
 * Missing host sources fail closed. No route/tool is installed by this export. */
export function createFactoryRunReviewIssuer(
  store: Pick<FactoryApprovalStore, "lockTask">,
  host: FactoryPublicationHost,
  signer: FactoryRunReviewSigner,
) {
  return {
    /** Trusted preparation path: read existing canonical artifacts, never accept
     * model/client observations. The second transaction in issue() rechecks the
     * same scope, evidence, executor and policy after the model call. */
    async prepare(tx: PoolClient, scopeInput: FactoryDecisionScope) {
      const scope = factoryDecisionScope.parse(scopeInput);
      if (host.ownerId !== scope.ownerId) fail("factoryPolicyDecisionMismatch");
      const task = await store.lockTask(tx, host.ownerId, scope.binding.taskId);
      if (
        task.userId !== host.ownerId ||
        task.stage !== "approval" ||
        !["pending", "waiting"].includes(task.status) ||
        digest(binding(task)) !== digest(scope.binding)
      )
        fail("factoryPolicyDecisionRevoked");
      const run = await lockFactoryPublicationExecutor(tx, host, task.issueId);
      if (run.kind === "acceptance" || !run.sessionId || !run.agentDefinition)
        fail("factoryPolicyDenied");
      const identity = task as FactoryTask & {
        botId?: unknown;
        sourceEventId?: unknown;
      };
      if (
        !run.startedAt ||
        !z.uuid().nullable().safeParse(identity.botId).success ||
        !z.uuid().safeParse(identity.sourceEventId).success ||
        run.botId !== identity.botId
      )
        fail("factoryPolicyDecisionMismatch");
      const {
        rows: [clock],
      } = await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      if (!clock?.now) fail("factoryPolicyDecisionUnavailable");
      const expires = Date.parse(scope.expiresAt);
      if (
        expires <= clock.now.getTime() ||
        expires > clock.now.getTime() + 24 * 60 * 60 * 1000
      )
        fail("factoryPolicyDecisionExpired");
      const policy = factoryCurrentPublicationPolicy.parse(
        await host.policy(tx, { task, run, scope }),
      );
      if (
        policy.ownerId !== host.ownerId ||
        policy.runId !== run.id ||
        policy.assignmentDigest !== digest(run.agentDefinition) ||
        policy.scopeDigest !== digest(scope) ||
        policy.permissionAction !== scope.action
      )
        fail("factoryPolicyDecisionMismatch");
      if (policy.readOnly || policy.decision === "deny")
        fail("factoryPolicyDenied");
      const current = await approvalEvidence(tx, task);
      if (
        current.evidenceDigest !== scope.evidenceDigest ||
        digest(current.manifest.candidate) !== digest(scope.candidate)
      )
        fail("factoryEvidenceMismatch");
      await readFactoryPassedCheckReceipts(tx, task);
      const requirements = await readFactoryPublicationRequirements(
        tx,
        task,
        run.agentDefinition,
      );
      // Frozen baseline has canonical reports/chunks only. It cannot bless an
      // arbitrary image URL or a caller's image hashes as actual visual input.
      // The real invocation asks the vision-capable model whether this scope
      // needs visual evidence. Missing images never establish text sufficiency.
      if (scope.visualEvidenceDigests.length) fail("factoryArtifactMissing");
      const artifacts = [];
      for (const ref of current.evidence) {
        const source = await readFactoryArtifact(tx, task, ref);
        const manifest = current.manifest.artifacts.find(
          (a) => a.artifact === ref.artifact && a.runId === ref.runId,
        );
        if (!manifest || manifest.sha256 !== digest(source.raw))
          fail("factoryEvidenceMismatch");
        artifacts.push({
          reference: ref,
          sha256: manifest.sha256,
          content: redactArtifact(source.raw),
        });
      }
      return {
        executor: {
          runId: run.id,
          sessionId: run.sessionId,
          assignmentDigest: digest(run.agentDefinition),
          instructionsDigest: digest(requirements),
          policyId: policy.id,
          policyRevision: policy.revision,
        },
        observations: {
          text: JSON.stringify({
            requirements: redactArtifact(requirements),
            manifest: current.manifest,
            artifacts,
          }),
          requiresVisual: false,
        },
      };
    },
    async issue(
      tx: PoolClient,
      scopeInput: FactoryDecisionScope,
      invocation: FactoryPublicationInvocation,
    ): Promise<z.infer<typeof factoryRunReviewChunk>> {
      const scope = factoryDecisionScope.parse(scopeInput);
      if (host.ownerId !== scope.ownerId) fail("factoryPolicyDecisionMismatch");
      const task = await store.lockTask(tx, host.ownerId, scope.binding.taskId);
      if (
        task.userId !== host.ownerId ||
        task.stage !== "approval" ||
        !["pending", "waiting"].includes(task.status) ||
        digest(binding(task)) !== digest(scope.binding)
      )
        fail("factoryPolicyDecisionRevoked");
      const run = await lockFactoryPublicationExecutor(tx, host, task.issueId);
      const identity = task as FactoryTask & {
        botId?: unknown;
        sourceEventId?: unknown;
      };
      if (run.kind === "acceptance") fail("factoryPolicyDenied");
      if (
        !run.sessionId ||
        !run.agentDefinition ||
        !run.startedAt ||
        !z.uuid().nullable().safeParse(identity.botId).success ||
        !z.uuid().safeParse(identity.sourceEventId).success ||
        run.botId !== identity.botId
      )
        fail("factoryPolicyDecisionMismatch");
      const {
        rows: [clock],
      } = await tx.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      if (!clock?.now) fail("factoryPolicyDecisionUnavailable");
      const now = clock.now.getTime(),
        expires = Date.parse(scope.expiresAt);
      if (expires <= now || expires > now + 24 * 60 * 60 * 1000)
        fail("factoryPolicyDecisionExpired");
      const parsedPolicy = factoryCurrentPublicationPolicy.safeParse(
        await host.policy(tx, { task, run, scope }),
      );
      if (!parsedPolicy.success) fail("factoryPolicyDecisionUnavailable");
      const policy = parsedPolicy.data;
      if (
        policy.ownerId !== host.ownerId ||
        policy.runId !== run.id ||
        policy.assignmentDigest !== digest(run.agentDefinition) ||
        policy.scopeDigest !== digest(scope) ||
        policy.permissionAction !== scope.action
      )
        fail("factoryPolicyDecisionMismatch");
      // Mechanical existing policy denial, never a model/program choice about
      // whether the business operation is desirable. No signer key is read.
      if (policy.readOnly || policy.decision === "deny")
        fail("factoryPolicyDenied");
      const current = await approvalEvidence(tx, task);
      if (
        current.evidenceDigest !== scope.evidenceDigest ||
        digest(current.manifest.candidate) !== digest(scope.candidate)
      )
        fail("factoryEvidenceMismatch");
      const checks = await readFactoryPassedCheckReceipts(tx, task);
      const requirements = await readFactoryPublicationRequirements(
        tx,
        task,
        run.agentDefinition,
      );
      const original = readFactoryPublicationInvocation(
        invocation,
        scope,
        host.decisionModelId,
        {
          runId: run.id,
          sessionId: run.sessionId,
          assignmentDigest: digest(run.agentDefinition),
          instructionsDigest: digest(requirements),
          policyId: policy.id,
          policyRevision: policy.revision,
        },
      );
      const judgment = original.judgment;
      if (
        !factoryDecisionExecutionMatches(judgment.execution, {
          modelId: host.decisionModelId,
          requestDigest: original.requestDigest,
          imageDigests: scope.visualEvidenceDigests,
          requiresVisual: original.judgment.visualInputRequired,
          scopeDigest: digest(scope),
          evidenceDigest: scope.evidenceDigest,
          startedAfter: new Date(run.startedAt).toISOString(),
          observedAt: clock.now.toISOString(),
        })
      )
        fail("factoryPolicyModelEvidenceUnavailable");
      const signingIdentity = {
        issuer: factoryRunReviewChunk.shape.data.shape.issuer.parse(
          signer.issuer,
        ),
        keyId: factoryRunReviewChunk.shape.data.shape.keyId.parse(signer.keyId),
      };
      const trustedKey = host.reviewKey(
        signingIdentity.issuer,
        signingIdentity.keyId,
      );
      if (
        !trustedKey ||
        trustedKey.type !== "public" ||
        trustedKey.asymmetricKeyType !== "ed25519"
      )
        fail("factoryPolicyDecisionUnavailable");
      const key = signer.privateKey();
      if (
        !key ||
        key.type !== "private" ||
        key.asymmetricKeyType !== "ed25519" ||
        fingerprint(createPublicKey(key)) !== fingerprint(trustedKey)
      )
        fail("factoryPolicyDecisionUnavailable");
      const payload = factoryRunReview.parse({
        version: 1,
        purpose: "factory-publication-review",
        credentialId: randomUUID(),
        ownerId: host.ownerId,
        executionRunId: run.id,
        executionSessionId: run.sessionId,
        assignmentDigest: digest(run.agentDefinition),
        instructionsDigest: digest(requirements),
        policyId: policy.id,
        policyRevision: policy.revision,
        permissionAction: policy.permissionAction,
        scopeDigest: digest(scope),
        issuedAt: clock.now.toISOString(),
        expiresAt: scope.expiresAt,
        checks,
        judgment,
      });
      const signature = sign(
        null,
        factoryRunReviewSignatureInput(payload, signingIdentity),
        key,
      ).toString("base64url");
      // ask is NOT elevated to allow here. This is only the review; the existing
      // consumer still requires its exact confirmation AFTER this issuedAt and
      // current policy/key/token/access fences before any grant or publication.
      return factoryRunReviewChunk.parse({
        type: "data-factory-publication-review",
        data: { ...signingIdentity, payload, signature },
      });
    },
  };
}
