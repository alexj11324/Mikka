import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { FactoryError, type FactoryBinding } from "./approval-contract";
import {
  approvalRequest,
  approvalControl,
  publicationRequest,
  type FactoryActor,
} from "./approval-contract";
import {
  approvalEvidence,
  digest,
  readFactoryArtifact,
  redactArtifact,
} from "./evidence";
import type {
  FactoryAuthorize,
  FactoryGate,
  FactoryTask,
  FactoryApprovalStore,
} from "./approval-dependencies";
import {
  publicationAdapterReceipt,
  assertPublicationTarget,
  type PublicationAdapterReceipt,
} from "./publication-receipt";
import {
  PublicationDeferred,
  publicationBindingHash,
  publicationPolicyBinding,
  type PublicationInput,
} from "./publication-operation";

import {
  authorizeFactoryDecision,
  type FactoryDecisionAuthority,
  type FactoryDecisionScope,
} from "./policy-authorization";

const principalId = (actor: FactoryActor) =>
  actor.sessionId ? `session:${actor.sessionId}` : `owner:${actor.userId}`;

function providerInput(
  task: FactoryTask,
  a: any,
  req: any,
  publicationId: string,
): PublicationInput {
  return {
    idempotencyKey: publicationId,
    candidate: a.candidate,
    authorization: {
      approvalId: a.id,
      ownerId: task.userId,
      ...(a.decisionEvidence
        ? { policy: publicationPolicyBinding(a.decisionEvidence) }
        : { humanSessionId: a.humanSessionId }),
      expiresAt: a.request.expiresAt,
      binding: req.binding,
      eventId: req.eventId,
      action: req.action,
      target: req.target,
      targetEnvironment: req.targetEnvironment,
    },
  };
}
function providerBinding(
  receipt: PublicationAdapterReceipt,
  input: PublicationInput,
) {
  const provider = receipt.verifiedTarget.provider;
  if (
    provider &&
    (provider.publicationId !== input.idempotencyKey ||
      provider.bindingHash !== publicationBindingHash(input))
  )
    throw new FactoryError("factoryPublicationReceiptMismatch");
}

function fail(code: string): never {
  throw new FactoryError(code);
}
const bindingOf = (t: FactoryTask): FactoryBinding => ({
  taskId: t.id,
  issueId: t.issueId,
  attemptId: t.attemptId,
  revision: t.revision,
  candidateId: t.candidateId,
});
const output = z
  .object({ approvalId: z.uuid(), publicationId: z.uuid().optional() })
  .strict();

/** Browser transport authentication, not a human-approval requirement. */
async function browserSession(tx: PoolClient, actor: FactoryActor) {
  if (!actor?.userId) fail("factoryActorRequired");
  if (!actor.sessionId) return; // Trusted backend owner still requires policy proof.
  const { rows } = await tx.query(
    `SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR SHARE`,
    [actor.sessionId, actor.userId],
  );
  if (!rows.length) fail("factoryHumanRequired");
}
function decisionScope(
  task: FactoryTask,
  req: z.infer<typeof approvalRequest>,
  current: Awaited<ReturnType<typeof approvalEvidence>>,
): FactoryDecisionScope {
  return {
    ownerId: task.userId,
    binding: req.binding,
    candidate: req.candidate,
    action: req.action,
    target: req.target,
    targetEnvironment: req.targetEnvironment,
    evidenceDigest: current.evidenceDigest,
    expiresAt: req.expiresAt,
    visualEvidenceDigests: current.manifest.artifacts
      .filter((a) => a.kind === "screenshot" || a.kind === "video")
      .map((a) => a.sha256),
  };
}

async function unusedEvent(tx: PoolClient, taskId: string, eventId: string) {
  const { rows } = await tx.query(
    `
    SELECT 1 FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2
    UNION ALL SELECT 1 FROM factory_approvals WHERE "taskId"=$1 AND "eventId"=$2
    UNION ALL SELECT 1 FROM factory_approval_controls WHERE "taskId"=$1 AND "eventId"=$2
    UNION ALL SELECT 1 FROM factory_publications WHERE "taskId"=$1 AND "eventId"=$2`,
    [taskId, eventId],
  );
  if (rows.length) fail("factoryReplayMismatch");
}

async function validApproval(
  tx: PoolClient,
  task: FactoryTask,
  id: string,
  publish: boolean,
  authority?: FactoryDecisionAuthority,
) {
  const {
    rows: [a],
  } = await tx.query(
    'SELECT * FROM factory_approvals WHERE id=$1 AND "taskId"=$2 AND "userId"=$3 AND "candidateId"=$4 AND "revokedAt" IS NULL AND "expiresAt">clock_timestamp() FOR UPDATE',
    [id, task.id, task.userId, task.candidateId],
  );
  if (
    !a ||
    typeof a.request?.targetEnvironment !== "string" ||
    !a.request.targetEnvironment ||
    (publish
      ? a.publishRevision !== task.revision ||
        a.publishAttemptId !== task.attemptId
      : a.approvedRevision !== task.revision || a.attemptId !== task.attemptId)
  )
    fail("factoryApprovalInvalid");
  const current = await approvalEvidence(tx, task);
  if (
    current.evidenceDigest !== a.evidenceDigest ||
    digest(current.manifest.candidate) !== digest(a.candidate) ||
    digest(current.manifest) !== digest(a.evidence)
  )
    fail("factoryApprovalInvalid");
  if (!a.decisionCredentialId || !a.decisionScope || !a.decisionEvidence)
    fail("factoryPolicyDecisionUnavailable");
  const expected = decisionScope(
    task,
    approvalRequest.parse(a.request),
    current,
  );
  if (digest(expected) !== digest(a.decisionScope))
    fail("factoryPolicyDecisionMismatch");
  const decision = await authorizeFactoryDecision(
    tx,
    authority,
    a.decisionCredentialId,
    expected,
  );
  if (digest(decision) !== digest(a.decisionEvidence))
    fail("factoryPolicyDecisionMismatch");
  return { a, current };
}

function gatesFor(authority?: FactoryDecisionAuthority) {
  const approvalGate: FactoryGate = async (tx, task, _attempt, change) => {
    const parsed = output.safeParse(change.output);
    if (
      task.stage !== "approval" ||
      !parsed.success ||
      parsed.data.publicationId
    )
      return false;
    const { current } = await validApproval(
      tx,
      task,
      parsed.data.approvalId,
      false,
      authority,
    );
    return digest(change.evidence) === digest(current.evidence);
  };
  const publishGate: FactoryGate = async (tx, task, _attempt, change) => {
    const parsed = output.safeParse(change.output);
    if (
      task.stage !== "publish" ||
      !parsed.success ||
      !parsed.data.publicationId
    )
      return false;
    const { a, current } = await validApproval(
      tx,
      task,
      parsed.data.approvalId,
      true,
      authority,
    );
    const {
      rows: [p],
    } = await tx.query(
      `SELECT * FROM factory_publications WHERE id=$1 AND "approvalId"=$2 AND status='succeeded' AND receipt IS NOT NULL`,
      [parsed.data.publicationId, a.id],
    );
    if (p) {
      const receipt = publicationAdapterReceipt.safeParse(p.receipt);
      if (!receipt.success) return false;
      providerBinding(receipt.data, providerInput(task, a, p.request, p.id));
      assertPublicationTarget(
        receipt.data,
        a.candidate,
        a.action,
        a.target,
        a.request.targetEnvironment,
        p.id,
      );
      if (
        new Date(receipt.data.verifiedTarget.observedAt).getTime() <
        p.createdAt.getTime()
      )
        return false;
    }
    return Boolean(
      p &&
      p.taskId === task.id &&
      p.candidateId === task.candidateId &&
      p.action === a.action &&
      p.target === a.target &&
      digest(change.evidence) === digest(current.evidence),
    );
  };

  return { approval: approvalGate, publish: publishGate };
}
export const createFactoryApprovalGates = gatesFor;
/** No implicit human fallback and no synthetic allow when an authority is absent. */
export const { approval: approvalGate, publish: publishGate } = gatesFor();

export interface PublicationAdapter {
  // Registered by trusted backend code. Never accept a callback/command from a tool.
  action: z.infer<typeof publicationRequest>["action"];
  target: string;
  environment: string;
  execute(input: PublicationInput): Promise<PublicationAdapterReceipt>;
  /** Read-only inspection. This method must never create/promote a deployment. */
  reconcile?(
    input: PublicationInput,
    checkpoint: unknown,
  ): Promise<PublicationAdapterReceipt>;
}

export function createFactoryApprovals(
  pool: Pool,
  authorize: FactoryAuthorize,
  store: FactoryApprovalStore,
  adapters: PublicationAdapter[] = [],
  authority?: FactoryDecisionAuthority,
) {
  async function transaction<T>(fn: (tx: PoolClient) => Promise<T>) {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const result = await fn(tx);
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  }
  async function owned(
    tx: PoolClient,
    actor: FactoryActor,
    taskId: string,
    allowStopped = false,
  ) {
    const task = await store.lockTask(tx, actor.userId, taskId);
    if (!task || !(await authorize(actor.userId, task.issueId, tx)))
      fail("factoryNotFound");
    if (!allowStopped && ["cancelled", "revoked"].includes(task.status))
      fail("factoryStopped");
    await browserSession(tx, actor);
    return task;
  }
  function fence(task: FactoryTask, binding: FactoryBinding) {
    if (digest(bindingOf(task)) !== digest(binding)) fail("factoryStale");
  }
  async function defer(error: unknown, publicationId: string): Promise<never> {
    const state =
      error instanceof PublicationDeferred ? error.state : "uncertain";
    const checkpoint =
      error instanceof PublicationDeferred ? error.checkpoint : null;
    await pool.query(
      `UPDATE factory_publications SET status=$2,receipt=coalesce($3::jsonb,receipt),"finishedAt"=clock_timestamp() WHERE id=$1 AND status<>'succeeded'`,
      [
        publicationId,
        state === "pending" ? "reserved" : "uncertain",
        checkpoint == null ? null : JSON.stringify(checkpoint),
      ],
    );
    if (error instanceof PublicationDeferred)
      throw new PublicationDeferred(publicationId, state, checkpoint);
    if (error instanceof FactoryError && error.code.startsWith("factoryVercel"))
      throw new PublicationDeferred(publicationId, "uncertain");
    throw error;
  }
  async function complete(
    tx: PoolClient,
    task: FactoryTask,
    req: any,
    a: any,
    current: Awaited<ReturnType<typeof approvalEvidence>>,
    receipt: PublicationAdapterReceipt,
    publicationId: string,
  ) {
    assertPublicationTarget(
      receipt,
      a.candidate,
      a.action,
      a.target,
      a.request.targetEnvironment,
      publicationId,
    );
    providerBinding(receipt, providerInput(task, a, req, publicationId));
    await tx.query(
      `UPDATE factory_publications SET status='succeeded',receipt=$2,"finishedAt"=clock_timestamp() WHERE id=$1 AND status IN ('reserved','uncertain')`,
      [publicationId, JSON.stringify(receipt)],
    );
    const result = await store.apply(
      task.userId,
      req.binding,
      req.eventId,
      {
        action: "finish",
        status: "passed",
        reason: "Trusted publication adapter returned a verified receipt",
        evidence: current.evidence,
        output: { approvalId: a.id, publicationId },
      },
      tx,
    );
    const response = {
      publicationId,
      receipt,
      binding: bindingOf(result.task),
    };
    await tx.query("UPDATE factory_publications SET result=$2 WHERE id=$1", [
      publicationId,
      JSON.stringify(response),
    ]);
    return response;
  }
  return {
    async ledger(actor: FactoryActor, taskId: string) {
      if (!z.uuid().safeParse(taskId).success) fail("factoryInvalid");
      return transaction(async (tx) => {
        const task = await owned(tx, actor, taskId, true);
        const { rows: approvals } = await tx.query(
          'SELECT id,"candidateId","userId",candidate,action,target,request->>\'targetEnvironment\' AS "targetEnvironment","evidenceDigest",evidence,"expiresAt","revokedAt","createdAt" FROM factory_approvals WHERE "taskId"=$1 ORDER BY "createdAt"',
          [task.id],
        );
        const { rows: publications } = await tx.query(
          'SELECT id,"approvalId","candidateId",action,target,request,request->>\'targetEnvironment\' AS "targetEnvironment",status,receipt,"createdAt","finishedAt" FROM factory_publications WHERE "taskId"=$1 ORDER BY "createdAt"',
          [task.id],
        );
        return { binding: bindingOf(task), approvals, publications };
      });
    },
    async artifact(actor: FactoryActor, taskId: string, artifact: string) {
      if (!z.uuid().safeParse(taskId).success) fail("factoryInvalid");
      return transaction(async (tx) => {
        const task = await owned(tx, actor, taskId, true);
        const current = await approvalEvidence(tx, task);
        const ref = current.evidence.find((e) => e.artifact === artifact);
        if (!ref) fail("factoryArtifactMissing");
        const source = await readFactoryArtifact(tx, task, ref);
        return {
          ...ref,
          ...source,
          raw: redactArtifact(source.raw),
          sourceSha256: digest(source.raw),
        };
      });
    },
    async evidence(actor: FactoryActor, taskId: string) {
      if (!z.uuid().safeParse(taskId).success) fail("factoryInvalid");
      return transaction(async (tx) => {
        const task = await owned(tx, actor, taskId);
        if (
          task.stage !== "approval" ||
          !["pending", "waiting"].includes(task.status)
        )
          fail("factoryTransition");
        const current = await approvalEvidence(tx, task),
          evidenceReadId = randomUUID();
        await tx.query(
          'INSERT INTO factory_evidence_reads (id,"taskId","userId","principalId",binding,"evidenceDigest") VALUES ($1,$2,$3,$4,$5,$6)',
          [
            evidenceReadId,
            task.id,
            actor.userId,
            principalId(actor),
            JSON.stringify(bindingOf(task)),
            current.evidenceDigest,
          ],
        );
        return { binding: bindingOf(task), ...current, evidenceReadId };
      });
    },
    async approve(actor: FactoryActor, input: unknown) {
      const parsed = approvalRequest.safeParse(input);
      if (!parsed.success) fail("factoryInvalid");
      const req = parsed.data;
      return transaction(async (tx) => {
        const task = await owned(tx, actor, req.binding.taskId);
        if (task.issueId !== req.binding.issueId) fail("factoryNotFound");
        const {
          rows: [prior],
        } = await tx.query(
          'SELECT * FROM factory_approvals WHERE "taskId"=$1 AND "eventId"=$2',
          [task.id, req.eventId],
        );
        if (prior) {
          if (
            digest(prior.request) !== digest(req) ||
            prior.principalId !== principalId(actor)
          )
            fail("factoryReplayMismatch");
          // No historical success response can revive an expired/revoked/stale approval.
          await validApproval(tx, task, prior.id, true, authority);
          return { approvalId: prior.id, binding: bindingOf(task) };
        }
        await unusedEvent(tx, task.id, req.eventId);
        fence(task, req.binding);
        if (
          task.stage !== "approval" ||
          !["pending", "waiting"].includes(task.status)
        )
          fail("factoryTransition");
        const current = await approvalEvidence(tx, task);
        if (!req.decisionCredentialId) fail("factoryPolicyDecisionUnavailable");
        const {
          rows: [read],
        } = await tx.query(
          `SELECT id FROM factory_evidence_reads WHERE id=$1 AND "taskId"=$2 AND "userId"=$3 AND "principalId"=$4 AND binding=$5::jsonb AND "evidenceDigest"=$6`,
          [
            req.evidenceReadId,
            task.id,
            actor.userId,
            principalId(actor),
            JSON.stringify(req.binding),
            current.evidenceDigest,
          ],
        );
        if (
          !read ||
          req.evidenceDigest !== current.evidenceDigest ||
          digest(req.candidate) !== digest(current.manifest.candidate)
        )
          fail("factoryEvidenceMismatch");
        const {
          rows: [expiry],
        } = await tx.query(
          "SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=clock_timestamp()+interval '24 hours' AS valid",
          [req.expiresAt],
        );
        if (!expiry.valid) fail("factoryApprovalExpiry");
        const scope = decisionScope(task, req, current);
        const decision = await authorizeFactoryDecision(
          tx,
          authority,
          req.decisionCredentialId,
          scope,
        );
        const approvalId = randomUUID();
        const inserted = await tx.query(
          `INSERT INTO factory_approvals (id,"taskId","candidateId","attemptId","userId","principalId","humanSessionId","decisionCredentialId","decisionScope","decisionEvidence","eventId",request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,$16,$17,$18,$19,$7,$8,$9,$10,$11,$12,$13,$14,$4,$14,$15) ON CONFLICT DO NOTHING RETURNING id`,
          [
            approvalId,
            task.id,
            task.candidateId,
            task.attemptId,
            actor.userId,
            principalId(actor),
            req.eventId,
            JSON.stringify(req),
            JSON.stringify(req.candidate),
            req.action,
            req.target,
            current.evidenceDigest,
            JSON.stringify(current.manifest),
            task.revision,
            req.expiresAt,
            decision.decision === "ask"
              ? decision.confirmation!.sessionId
              : null,
            req.decisionCredentialId,
            JSON.stringify(scope),
            JSON.stringify(decision),
          ],
        );
        if (!inserted.rowCount) fail("factoryPolicyDecisionAlreadyConsumed");
        let result = await store.apply(
          actor.userId,
          req.binding,
          req.eventId,
          {
            action: "finish",
            status: "passed",
            reason:
              "Existing policy authorized exact candidate and model-grounded evidence",
            evidence: current.evidence,
            output: { approvalId },
          },
          tx,
        );
        result = await store.apply(
          actor.userId,
          bindingOf(result.task),
          randomUUID(),
          {
            action: "advance",
            stage: "publish",
            reason: "Await exact approved publication action",
          },
          tx,
        );
        await tx.query(
          'UPDATE factory_approvals SET "publishAttemptId"=$2,"publishRevision"=$3 WHERE id=$1',
          [approvalId, result.task.attemptId, result.task.revision],
        );
        return { approvalId, binding: bindingOf(result.task) };
      });
    },
    async revoke(actor: FactoryActor, input: unknown) {
      const parsed = approvalControl.safeParse(input);
      if (!parsed.success) fail("factoryInvalid");
      const req = parsed.data;
      return transaction(async (tx) => {
        const task = await owned(tx, actor, req.binding.taskId);
        fence(task, req.binding);
        const {
          rows: [prior],
        } = await tx.query(
          'SELECT request,result,"principalId" FROM factory_approval_controls WHERE "taskId"=$1 AND "eventId"=$2',
          [task.id, req.eventId],
        );
        if (prior) {
          if (
            digest(prior.request) !== digest(req) ||
            prior.principalId !== principalId(actor)
          )
            fail("factoryReplayMismatch");
          return prior.result as { approvalId: string; revoked: boolean };
        }
        await unusedEvent(tx, task.id, req.eventId);
        const { rowCount } = await tx.query(
          'UPDATE factory_approvals SET "revokedAt"=coalesce("revokedAt",clock_timestamp()) WHERE id=$1 AND "taskId"=$2 AND "userId"=$3',
          [req.approvalId, task.id, actor.userId],
        );
        if (!rowCount) fail("factoryApprovalInvalid");
        const result = { approvalId: req.approvalId, revoked: true };
        await tx.query(
          'INSERT INTO factory_approval_controls ("taskId","eventId","userId","principalId",request,result) VALUES ($1,$2,$3,$4,$5,$6)',
          [
            task.id,
            req.eventId,
            actor.userId,
            principalId(actor),
            JSON.stringify(req),
            JSON.stringify(result),
          ],
        );
        return result;
      });
    },
    async publish(actor: FactoryActor, input: unknown) {
      const parsed = publicationRequest.safeParse(input);
      if (!parsed.success) fail("factoryInvalid");
      const req = parsed.data;
      const adapter = adapters.find(
        (a) =>
          a.action === req.action &&
          a.target === req.target &&
          a.environment === req.targetEnvironment,
      );
      if (!adapter) fail("factoryPublicationUnavailable");
      const reservation = await transaction(async (tx) => {
        const task = await owned(tx, actor, req.binding.taskId);
        const {
          rows: [replay],
        } = await tx.query(
          'SELECT * FROM factory_publications WHERE "taskId"=$1 AND "eventId"=$2',
          [task.id, req.eventId],
        );
        if (replay) {
          if (digest(replay.request) !== digest(req))
            fail("factoryReplayMismatch");
          if (replay.status !== "succeeded" || !replay.result)
            fail("factoryPublicationAlreadyClaimed");
          // Historical receipts never reopen a later candidate, retry or revoked task.
          if (
            task.stage !== "publish" ||
            task.status !== "passed" ||
            digest(bindingOf(task)) !== digest(replay.result.binding)
          )
            fail("factoryStale");
          await validApproval(
            tx,
            { ...task, revision: req.binding.revision },
            req.approvalId,
            true,
            authority,
          );
          return {
            result: replay.result as {
              publicationId: string;
              receipt: PublicationAdapterReceipt;
              binding: FactoryBinding;
            },
          };
        }
        await unusedEvent(tx, task.id, req.eventId);
        fence(task, req.binding);
        if (task.stage !== "publish" || task.status !== "pending")
          fail("factoryTransition");
        const { a } = await validApproval(
          tx,
          task,
          req.approvalId,
          true,
          authority,
        );
        if (
          a.action !== req.action ||
          a.target !== req.target ||
          a.request.targetEnvironment !== req.targetEnvironment
        )
          fail("factoryApprovalInvalid");
        const {
          rows: [prior],
        } = await tx.query(
          'SELECT id FROM factory_publications WHERE "taskId"=$1 AND "candidateId"=$2 AND action=$3 AND target=$4',
          [task.id, task.candidateId, req.action, req.target],
        );
        if (prior) fail("factoryPublicationAlreadyClaimed");
        const id = randomUUID();
        await tx.query(
          `INSERT INTO factory_publications (id,"approvalId","taskId","candidateId",action,target,"eventId",request,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved')`,
          [
            id,
            a.id,
            task.id,
            task.candidateId,
            req.action,
            req.target,
            req.eventId,
            JSON.stringify(req),
          ],
        );
        return { id };
      });
      if ("result" in reservation) return reservation.result;
      const publicationId = reservation.id;
      // Durable reservation precedes the effect: on crash/unknown outcome it
      // is never retried automatically. Hold the task lock through execution,
      // so cancellation/revocation cannot interleave with the final fence.
      try {
        return await transaction(async (tx) => {
          const task = await owned(tx, actor, req.binding.taskId);
          fence(task, req.binding);
          const {
            rows: [claim],
          } = await tx.query(
            "SELECT status,receipt FROM factory_publications WHERE id=$1 FOR UPDATE",
            [publicationId],
          );
          if (claim?.status !== "reserved" || claim.receipt != null)
            fail("factoryPublicationAlreadyClaimed");
          const { a, current } = await validApproval(
            tx,
            task,
            req.approvalId,
            true,
            authority,
          );
          const trustedInput = providerInput(task, a, req, publicationId);
          trustedInput.beforeCreate = async () => {
            const latest = await owned(tx, actor, task.id);
            fence(latest, req.binding);
            await validApproval(tx, latest, req.approvalId, true, authority);
          };
          const receipt = publicationAdapterReceipt.parse(
            await adapter.execute(trustedInput),
          );
          return complete(tx, task, req, a, current, receipt, publicationId);
        });
      } catch (error) {
        return defer(error, publicationId);
      }
    },
    async reconcile(actor: FactoryActor, input: unknown) {
      const parsed = publicationRequest
        .extend({ publicationId: z.uuid() })
        .strict()
        .safeParse(input);
      if (!parsed.success) fail("factoryInvalid");
      const { publicationId, ...req } = parsed.data;
      try {
        return await transaction(async (tx) => {
          const task = await owned(tx, actor, req.binding.taskId);
          const {
            rows: [p],
          } = await tx.query(
            'SELECT * FROM factory_publications WHERE id=$1 AND "taskId"=$2 AND "approvalId"=$3 FOR UPDATE',
            [publicationId, task.id, req.approvalId],
          );
          if (!p) fail("factoryPublicationReceiptRequired");
          if (digest(p.request) !== digest(req)) fail("factoryReplayMismatch");
          if (p.status === "succeeded") {
            if (
              task.stage !== "publish" ||
              task.status !== "passed" ||
              digest(bindingOf(task)) !== digest(p.result?.binding)
            )
              fail("factoryStale");
            await validApproval(
              tx,
              { ...task, revision: req.binding.revision },
              req.approvalId,
              true,
              authority,
            );
            return p.result as {
              publicationId: string;
              receipt: PublicationAdapterReceipt;
              binding: FactoryBinding;
            };
          }
          fence(task, req.binding);
          if (task.stage !== "publish" || task.status !== "pending")
            fail("factoryTransition");
          const { a, current } = await validApproval(
            tx,
            task,
            req.approvalId,
            true,
            authority,
          );
          const adapter = adapters.find(
            (x) =>
              x.action === a.action &&
              x.target === a.target &&
              x.environment === a.request.targetEnvironment,
          );
          if (!adapter?.reconcile) fail("factoryPublicationUnavailable");
          const receipt = publicationAdapterReceipt.parse(
            await adapter.reconcile(
              providerInput(task, a, req, publicationId),
              p.receipt,
            ),
          );
          return complete(tx, task, req, a, current, receipt, publicationId);
        });
      } catch (error) {
        // Only actual provider/deferred failures update an existing reservation.
        // Invalid ownership/fence/request errors must not mutate another grant.
        if (
          error instanceof PublicationDeferred ||
          (error instanceof FactoryError &&
            error.code.startsWith("factoryVercel"))
        )
          return defer(error, publicationId);
        throw error;
      }
    },
  };
}
