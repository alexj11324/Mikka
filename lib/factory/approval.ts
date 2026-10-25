import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { FactoryError, type FactoryBinding } from "./contract";
import {
  approvalRequest,
  approvalControl,
  publicationRequest,
  type FactoryHuman,
} from "./approval-contract";
import {
  approvalEvidence,
  candidateIdentity,
  digest,
  readFactoryArtifact,
  redactArtifact,
} from "./evidence";
import type {
  FactoryAuthorize,
  FactoryGate,
  FactoryTask,
  createFactoryStore,
} from "./store";

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

async function human(tx: PoolClient, actor: FactoryHuman) {
  if (!actor?.userId || !actor.sessionId) fail("factoryHumanRequired");
  // The route must first authenticate this session cookie with Better Auth.
  // These checks re-evaluate expiry/sign-out and linked identity in the transaction.
  const { rows } = await tx.query(
    `SELECT s.id FROM "session" s WHERE s.id=$1 AND s."userId"=$2 AND s."expiresAt">clock_timestamp()
     AND EXISTS (SELECT 1 FROM account a WHERE a."userId"=s."userId" AND a."providerId" IN ('github','google')) FOR SHARE`,
    [actor.sessionId, actor.userId],
  );
  if (!rows.length) fail("factoryHumanRequired");
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
) {
  const {
    rows: [a],
  } = await tx.query(
    'SELECT * FROM factory_approvals WHERE id=$1 AND "taskId"=$2 AND "userId"=$3 AND "candidateId"=$4 AND "revokedAt" IS NULL AND "expiresAt">clock_timestamp() FOR UPDATE',
    [id, task.id, task.userId, task.candidateId],
  );
  if (
    !a ||
    (publish
      ? a.publishRevision !== task.revision ||
        a.publishAttemptId !== task.attemptId
      : a.approvedRevision !== task.revision || a.attemptId !== task.attemptId)
  )
    fail("factoryApprovalInvalid");
  await human(tx, { userId: a.userId, sessionId: a.humanSessionId });
  const current = await approvalEvidence(tx, task);
  if (
    current.evidenceDigest !== a.evidenceDigest ||
    digest(current.manifest.candidate) !== digest(a.candidate) ||
    digest(current.manifest) !== digest(a.evidence)
  )
    fail("factoryApprovalInvalid");
  return { a, current };
}

export const approvalGate: FactoryGate = async (tx, task, _attempt, change) => {
  const parsed = output.safeParse(change.output);
  if (task.stage !== "approval" || !parsed.success || parsed.data.publicationId)
    return false;
  const { current } = await validApproval(
    tx,
    task,
    parsed.data.approvalId,
    false,
  );
  return digest(change.evidence) === digest(current.evidence);
};
export const publishGate: FactoryGate = async (tx, task, _attempt, change) => {
  const parsed = output.safeParse(change.output);
  if (task.stage !== "publish" || !parsed.success || !parsed.data.publicationId)
    return false;
  const { a, current } = await validApproval(
    tx,
    task,
    parsed.data.approvalId,
    true,
  );
  const {
    rows: [p],
  } = await tx.query(
    `SELECT * FROM factory_publications WHERE id=$1 AND "approvalId"=$2 AND status='succeeded' AND receipt IS NOT NULL`,
    [parsed.data.publicationId, a.id],
  );
  return Boolean(
    p &&
    p.taskId === task.id &&
    p.candidateId === task.candidateId &&
    p.action === a.action &&
    p.target === a.target &&
    digest(change.evidence) === digest(current.evidence),
  );
};

export interface PublicationAdapter {
  // Registered by trusted backend code. Never accept a callback/command from a tool.
  action: z.infer<typeof publicationRequest>["action"];
  target: string;
  execute(input: {
    idempotencyKey: string;
    candidate: ReturnType<typeof candidateIdentity>;
  }): Promise<{ reference: string }>;
}

export function createFactoryApprovals(
  pool: Pool,
  authorize: FactoryAuthorize,
  store: ReturnType<typeof createFactoryStore>,
  adapters: PublicationAdapter[] = [],
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
    actor: FactoryHuman,
    taskId: string,
    allowStopped = false,
  ) {
    const {
      rows: [task],
    } = await tx.query<FactoryTask>(
      'SELECT * FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR UPDATE',
      [taskId, actor.userId],
    );
    if (!task || !(await authorize(actor.userId, task.issueId, tx)))
      fail("factoryNotFound");
    if (!allowStopped && ["cancelled", "revoked"].includes(task.status))
      fail("factoryStopped");
    await human(tx, actor);
    return task;
  }
  function fence(task: FactoryTask, binding: FactoryBinding) {
    if (digest(bindingOf(task)) !== digest(binding)) fail("factoryStale");
  }
  return {
    async ledger(actor: FactoryHuman, taskId: string) {
      if (!z.uuid().safeParse(taskId).success) fail("factoryInvalid");
      return transaction(async (tx) => {
        const task = await owned(tx, actor, taskId, true);
        const { rows: approvals } = await tx.query(
          'SELECT id,"candidateId","userId",candidate,action,target,"evidenceDigest",evidence,"expiresAt","revokedAt","createdAt" FROM factory_approvals WHERE "taskId"=$1 ORDER BY "createdAt"',
          [task.id],
        );
        const { rows: publications } = await tx.query(
          'SELECT id,"approvalId","candidateId",action,target,status,receipt,"createdAt","finishedAt" FROM factory_publications WHERE "taskId"=$1 ORDER BY "createdAt"',
          [task.id],
        );
        return { binding: bindingOf(task), approvals, publications };
      });
    },
    async artifact(actor: FactoryHuman, taskId: string, artifact: string) {
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
    async evidence(actor: FactoryHuman, taskId: string) {
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
          'INSERT INTO factory_evidence_reads (id,"taskId","userId","humanSessionId",binding,"evidenceDigest") VALUES ($1,$2,$3,$4,$5,$6)',
          [
            evidenceReadId,
            task.id,
            actor.userId,
            actor.sessionId,
            JSON.stringify(bindingOf(task)),
            current.evidenceDigest,
          ],
        );
        return { binding: bindingOf(task), ...current, evidenceReadId };
      });
    },
    async approve(actor: FactoryHuman, input: unknown) {
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
            prior.humanSessionId !== actor.sessionId
          )
            fail("factoryReplayMismatch");
          // No historical success response can revive an expired/revoked/stale approval.
          await validApproval(tx, task, prior.id, true);
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
        const {
          rows: [read],
        } = await tx.query(
          `SELECT id FROM factory_evidence_reads WHERE id=$1 AND "taskId"=$2 AND "userId"=$3 AND "humanSessionId"=$4 AND binding=$5::jsonb AND "evidenceDigest"=$6`,
          [
            req.evidenceReadId,
            task.id,
            actor.userId,
            actor.sessionId,
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
        const approvalId = randomUUID();
        await tx.query(
          `INSERT INTO factory_approvals (id,"taskId","candidateId","attemptId","userId","humanSessionId","eventId",request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$4,$14,$15)`,
          [
            approvalId,
            task.id,
            task.candidateId,
            task.attemptId,
            actor.userId,
            actor.sessionId,
            req.eventId,
            JSON.stringify(req),
            JSON.stringify(req.candidate),
            req.action,
            req.target,
            current.evidenceDigest,
            JSON.stringify(current.manifest),
            task.revision,
            req.expiresAt,
          ],
        );
        let result = await store.apply(
          actor.userId,
          req.binding,
          req.eventId,
          {
            action: "finish",
            status: "passed",
            reason: "Human approved exact candidate and evidence",
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
    async revoke(actor: FactoryHuman, input: unknown) {
      const parsed = approvalControl.safeParse(input);
      if (!parsed.success) fail("factoryInvalid");
      const req = parsed.data;
      return transaction(async (tx) => {
        const task = await owned(tx, actor, req.binding.taskId);
        fence(task, req.binding);
        const {
          rows: [prior],
        } = await tx.query(
          'SELECT request,result,"humanSessionId" FROM factory_approval_controls WHERE "taskId"=$1 AND "eventId"=$2',
          [task.id, req.eventId],
        );
        if (prior) {
          if (
            digest(prior.request) !== digest(req) ||
            prior.humanSessionId !== actor.sessionId
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
          'INSERT INTO factory_approval_controls ("taskId","eventId","userId","humanSessionId",request,result) VALUES ($1,$2,$3,$4,$5,$6)',
          [
            task.id,
            req.eventId,
            actor.userId,
            actor.sessionId,
            JSON.stringify(req),
            JSON.stringify(result),
          ],
        );
        return result;
      });
    },
    async publish(actor: FactoryHuman, input: unknown) {
      const parsed = publicationRequest.safeParse(input);
      if (!parsed.success) fail("factoryInvalid");
      const req = parsed.data;
      // No production publication implementation is supplied by this issue.
      if (req.action === "deploy_production")
        fail("factoryPublicationUnavailable");
      const adapter = adapters.find(
        (a) => a.action === req.action && a.target === req.target,
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
          );
          return {
            result: replay.result as {
              publicationId: string;
              receipt: { reference: string };
              binding: FactoryBinding;
            },
          };
        }
        await unusedEvent(tx, task.id, req.eventId);
        fence(task, req.binding);
        if (task.stage !== "publish" || task.status !== "pending")
          fail("factoryTransition");
        const { a } = await validApproval(tx, task, req.approvalId, true);
        if (a.action !== req.action || a.target !== req.target)
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
          const { a, current } = await validApproval(
            tx,
            task,
            req.approvalId,
            true,
          );
          const receipt = z
            .object({ reference: z.string().min(1).max(2000) })
            .strict()
            .parse(
              await adapter.execute({
                idempotencyKey: publicationId,
                candidate: a.candidate,
              }),
            );
          await tx.query(
            `UPDATE factory_publications SET status='succeeded',receipt=$2,"finishedAt"=clock_timestamp() WHERE id=$1 AND status='reserved'`,
            [publicationId, JSON.stringify(receipt)],
          );
          const result = await store.apply(
            actor.userId,
            req.binding,
            req.eventId,
            {
              action: "finish",
              status: "passed",
              reason: "Trusted publication adapter returned a receipt",
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
          await tx.query(
            "UPDATE factory_publications SET result=$2 WHERE id=$1",
            [publicationId, JSON.stringify(response)],
          );
          return response;
        });
      } catch (error) {
        await pool.query(
          `UPDATE factory_publications SET status='uncertain',"finishedAt"=clock_timestamp() WHERE id=$1 AND status='reserved'`,
          [publicationId],
        );
        throw error;
      }
    },
  };
}
