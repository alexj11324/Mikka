import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { runEventBatchSchema } from "@mikka/protocol/device";
import { z } from "zod";
import { digest } from "../../lib/factory/evidence";
import { FactoryError } from "../../lib/factory/approval-contract";
import { createLocalPublicationAdapter } from "../../lib/factory/local-publication";
import { readFactoryPublicationReceiptV2 } from "../../lib/factory/publication-receipt";
import {
  createFactoryPublicationHost,
  factoryRunReviewSignatureInput,
  type factoryRunReview,
  type FactoryPublicationHost,
} from "../../lib/factory/run-decision-authority";
import type { factory194Fixture } from "./factory194";

/** Synthetic Ed25519 materials exist only in this isolated test process.
 * Every signed scope targets a disposable local artifact, never a cloud target.
 * The policy/confirmation tables below are test fixtures, NOT production sources. */
export async function factoryRunAuthorityCases(
  t: TestContext,
  f: Awaited<ReturnType<typeof factory194Fixture>>,
) {
  const { pool } = f,
    actor = { userId: f.actor.userId };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const directories: string[] = [];
  await pool.query(`CREATE TABLE factory_policy_fixture ("runId" uuid PRIMARY KEY,id text,revision text,"ownerId" text,"assignmentDigest" text,"permissionAction" text,"readOnly" boolean,decision text,"scopeDigest" text);
    CREATE TABLE factory_confirmation_fixture ("credentialId" uuid PRIMARY KEY,body jsonb);`);
  const rejects = (fn: () => Promise<unknown>, code: string) =>
    assert.rejects(fn, (e) => e instanceof FactoryError && e.code === code);
  async function fixture() {
    const x = await f.prepare(actor),
      runId = randomUUID(),
      credentialId = randomUUID(),
      tokenId = randomUUID();
    const tokenHash = createHash("sha256")
      .update(`synthetic-unissued-run-token:${randomUUID()}`)
      .digest("hex");
    const definition = {
      schemaVersion: 1,
      kind: "worker",
      harness: "codex",
      instructions: "Isolated review fixture",
      definitionDigest: digest("fixture-definition"),
      promptDigest: digest("fixture-prompt"),
      modelSource: "native-default",
      parent: null,
    };
    const root = await mkdtemp(join(tmpdir(), "factory194-authority-"));
    directories.push(root);
    const checks: z.infer<typeof factoryRunReview>["checks"] = [];
    const metadata = (
      await pool.query(
        'SELECT "botId","sourceEventId" FROM factory_tasks WHERE id=$1',
        [x.task.id],
      )
    ).rows[0];
    for (const stage of ["review", "verify"] as const) {
      const a = (
        await pool.query(
          'SELECT * FROM factory_attempts WHERE "taskId"=$1 AND stage=$2',
          [x.task.id, stage],
        )
      ).rows[0];
      const eventId = randomUUID(),
        b = {
          ...x.approval.binding,
          attemptId: a.id,
          revision: stage === "review" ? 4 : 6,
        };
      await pool.query(
        'INSERT INTO factory_events ("taskId","eventId",request,result) VALUES ($1,$2,$3,$4)',
        [
          x.task.id,
          eventId,
          JSON.stringify({
            binding: b,
            change: {
              action: "finish",
              status: "passed",
              reason: "Synthetic independent check",
              evidence: a.evidence,
              output: a.output,
            },
          }),
          JSON.stringify({
            contractVersion: 1,
            task: {
              ...x.task,
              ...metadata,
              stage,
              status: "passed",
              attemptId: a.id,
              revision: b.revision + 1,
            },
            attempts: [a],
          }),
        ],
      );
      checks.push({
        stage,
        attemptId: a.id,
        runId: a.runId,
        sessionId: a.sessionId,
        eventId,
      });
    }
    // Signed scope is intentionally a synthetic repository and local target.
    const candidate = { ...x.candidate, repository: "fixture/Factory194" };
    await pool.query(
      "UPDATE factory_candidates SET repository=$2 WHERE id=$1",
      [x.task.candidateId, candidate.repository],
    );
    const deviceId = randomUUID();
    await pool.query("INSERT INTO devices VALUES($1,$2,true)", [
      deviceId,
      actor.userId,
    ]);
    await pool.query(
      `INSERT INTO agent_runs(id,"userId","issueId","sessionId",status,"deviceId","agentDefinition","leaseExpiresAt","startedAt") VALUES($1,$2,$3,$4,'running',$5,$6,clock_timestamp()+interval '1 hour',clock_timestamp())`,
      [
        runId,
        actor.userId,
        x.task.issueId,
        "synthetic-executor-session",
        deviceId,
        JSON.stringify(definition),
      ],
    );
    await pool.query(
      "INSERT INTO run_tokens VALUES($1,$2,$3,$4,NULL,clock_timestamp()+interval '1 hour')",
      [tokenId, runId, actor.userId, tokenHash],
    );
    await pool.query(
      `INSERT INTO factory_policy_fixture VALUES($1,'synthetic-explicit-publication','1',$2,$3,'deploy_preview',false,'allow',NULL)`,
      [runId, actor.userId, digest(definition)],
    );
    const state = {
      keyAvailable: true,
      policyAvailable: true,
      waitBeforeWrite: undefined as undefined | (() => Promise<void>),
    };
    const host: FactoryPublicationHost = {
      ownerId: actor.userId,
      executionRunId: runId,
      tokenHash,
      reviewKey: (issuer, keyId) =>
        state.keyAvailable &&
        issuer === "synthetic-review-transport" &&
        keyId === "ephemeral-test-key"
          ? publicKey
          : undefined,
      policy: async (tx, { run }) =>
        state.policyAvailable
          ? (
              await tx.query(
                'SELECT id,revision,"ownerId","runId","assignmentDigest","permissionAction","readOnly",decision,"scopeDigest" FROM factory_policy_fixture WHERE "runId"=$1 FOR SHARE',
                [run.id],
              )
            ).rows[0]
          : null,
      confirmation: async (tx, { credentialId }) => {
        const c = (
          await tx.query(
            'SELECT body FROM factory_confirmation_fixture WHERE "credentialId"=$1 FOR SHARE',
            [credentialId],
          )
        ).rows[0]?.body;
        if (!c) return undefined;
        const live = await tx.query(
          'SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR SHARE',
          [c.sessionId, actor.userId],
        );
        return live.rowCount ? c : undefined;
      },
    };
    const local = createLocalPublicationAdapter({
      root,
      target: "synthetic-local-publication",
      repository: candidate.repository,
      environment: "local-fixture",
      candidateEnvironment: candidate.environment,
    });
    const adapter = {
      ...local,
      execute: async (input: Parameters<typeof local.execute>[0]) => {
        await state.waitBeforeWrite?.();
        await input.beforeCreate?.();
        return local.execute(input);
      },
    };
    const runtime = createFactoryPublicationHost(
      pool,
      f.authorize,
      (gates) => f.makeStore(gates),
      host,
      [adapter],
    );
    const evidence = await runtime.approvals.evidence(actor, x.task.id);
    const request = {
      ...x.approval,
      candidate: candidate,
      decisionCredentialId: credentialId,
      target: local.target,
      targetEnvironment: local.environment,
      evidenceDigest: evidence.evidenceDigest,
      evidenceReadId: evidence.evidenceReadId,
    };
    const scope = {
      ownerId: actor.userId,
      binding: request.binding,
      candidate: candidate,
      action: request.action,
      target: request.target,
      targetEnvironment: request.targetEnvironment,
      evidenceDigest: evidence.evidenceDigest,
      visualEvidenceDigests: [],
      expiresAt: request.expiresAt,
    };
    await pool.query(
      'UPDATE factory_policy_fixture SET "scopeDigest"=$2 WHERE "runId"=$1',
      [runId, digest(scope)],
    );
    const now = (await pool.query("SELECT clock_timestamp() AS now")).rows[0]
      .now as Date;
    const payload: z.infer<typeof factoryRunReview> = {
      version: 1,
      purpose: "factory-publication-review",
      credentialId,
      ownerId: actor.userId,
      executionRunId: runId,
      executionSessionId: "synthetic-executor-session",
      assignmentDigest: digest(definition),
      policyId: "synthetic-explicit-publication",
      policyRevision: "1",
      permissionAction: "deploy_preview",
      scopeDigest: digest(scope),
      issuedAt: now.toISOString(),
      expiresAt: request.expiresAt,
      checks,
      judgment: {
        receiptId: "synthetic-model-invocation",
        model: "synthetic-vision-capable-model",
        capability: "vision",
        visualInputRequired: false,
        scopeDigest: digest(scope),
        evidenceDigest: evidence.evidenceDigest,
        imageDigests: [],
      },
    };
    const identity = {
      issuer: "synthetic-review-transport",
      keyId: "ephemeral-test-key",
    };
    const envelope = {
      issuer: "synthetic-review-transport",
      keyId: "ephemeral-test-key",
      payload,
      signature: sign(
        null,
        factoryRunReviewSignatureInput(payload, identity),
        privateKey,
      ).toString("base64url"),
    };
    const chunkId = randomUUID();
    const chunk = { type: "data-factory-publication-review", data: envelope };
    assert.ok(
      runEventBatchSchema.safeParse({ fromSeq: 1, chunks: [chunk] }).success,
    );
    await pool.query(
      'INSERT INTO run_chunks (id,"runId",seq,chunk,"createdAt") VALUES($1,$2,1,$3,clock_timestamp())',
      [chunkId, runId, JSON.stringify(chunk)],
    );
    const publication = async () => ({
      ...(await runtime.approvals.approve(actor, request)),
      eventId: randomUUID(),
      action: request.action,
      target: request.target,
      targetEnvironment: request.targetEnvironment,
    });
    return {
      x,
      runId,
      credentialId,
      chunkId,
      tokenId,
      root,
      scope,
      host,
      state,
      request,
      runtime,
      payload,
      envelope,
      publication,
    };
  }
  try {
    await t.test(
      "real Ed25519 + owned chunk/token/run/passed-event/policy lookup; allow creates one actual local artifact and V2 receipt",
      async () => {
        const c = await fixture(),
          p = await c.publication();
        await pool.query(
          'INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") SELECT $1,"runId",2,chunk,clock_timestamp() FROM run_chunks WHERE id=$2',
          [randomUUID(), c.chunkId],
        );
        assert.equal(
          (await c.runtime.approvals.approve(actor, c.request)).approvalId,
          p.approvalId,
        );
        const a = await c.runtime.approvals.publish(actor, p);
        assert.ok(a);
        await c.runtime.approvals.publish(actor, p);
        assert.equal((await readdir(c.root)).length, 1);
        const tx = await pool.connect();
        try {
          assert.equal(
            (
              await readFactoryPublicationReceiptV2(
                tx,
                actor.userId,
                c.x.task.id,
                c.x.task.candidateId!,
              )
            ).publicationId,
            a.publicationId,
          );
        } finally {
          tx.release();
        }
        const grant = (
          await pool.query(
            'SELECT "humanSessionId","decisionEvidence" FROM factory_approvals WHERE id=$1',
            [p.approvalId],
          )
        ).rows[0];
        assert.equal(grant.humanSessionId, null);
        assert.equal(grant.decisionEvidence.verification.receiptId, c.chunkId);
        assert.equal(
          grant.decisionEvidence.verification.runBinding.runId,
          c.runId,
        );
        assert.equal(
          grant.decisionEvidence.verification.runBinding.reviewDigest,
          digest(c.envelope),
        );
      },
    );
    await t.test(
      "tampered signature/scope/issuer, revoked token, STOP, expired lease, changed assignment/current policy and missing check receipt deny before effects",
      async () => {
        for (const scenario of [
          "signature",
          "owner",
          "bot",
          "check-source",
          "issue",
          "session",
          "expired-review",
          "self-allow",
          "candidate",
          "token-expiry",
          "scope",
          "issuer",
          "trusted-alias",
          "token",
          "stop",
          "lease",
          "assignment",
          "policy",
          "registration",
          "policy-target",
          "check",
          "readonly",
          "readonly-run",
          "device",
          "missing-policy",
        ]) {
          const c = await fixture();
          if (scenario === "signature") c.envelope.signature = "A".repeat(86);
          if (scenario === "scope")
            c.envelope.payload.scopeDigest = "f".repeat(64);
          if (scenario === "issuer") c.envelope.issuer = "untrusted-model";
          if (scenario === "trusted-alias") {
            c.envelope.issuer = "synthetic-alias";
            c.host.reviewKey = () => publicKey;
          }
          if (scenario === "expired-review") {
            c.envelope.payload.expiresAt = new Date(
              Date.now() - 1000,
            ).toISOString();
            c.envelope.signature = sign(
              null,
              factoryRunReviewSignatureInput(c.envelope.payload, c.envelope),
              privateKey,
            ).toString("base64url");
          }
          if (scenario === "self-allow")
            Object.assign(c.envelope.payload, { decision: "allow" });
          if (
            [
              "signature",
              "scope",
              "issuer",
              "trusted-alias",
              "expired-review",
              "self-allow",
            ].includes(scenario)
          )
            await pool.query("UPDATE run_chunks SET chunk=$2 WHERE id=$1", [
              c.chunkId,
              JSON.stringify({
                type: "data-factory-publication-review",
                data: c.envelope,
              }),
            ]);
          if (scenario === "bot")
            await pool.query('UPDATE agent_runs SET "botId"=$2 WHERE id=$1', [
              c.runId,
              randomUUID(),
            ]);
          if (scenario === "check-source")
            await pool.query(
              "UPDATE factory_events SET result=jsonb_set(result,'{task,sourceEventId}',to_jsonb($2::text)) WHERE \"taskId\"=$1",
              [c.x.task.id, randomUUID()],
            );
          if (scenario === "owner")
            await pool.query(
              "UPDATE agent_runs SET \"userId\"='different-owner' WHERE id=$1",
              [c.runId],
            );
          if (scenario === "issue")
            await pool.query('UPDATE agent_runs SET "issueId"=$2 WHERE id=$1', [
              c.runId,
              randomUUID(),
            ]);
          if (scenario === "session")
            await pool.query(
              "UPDATE agent_runs SET \"sessionId\"='different-session' WHERE id=$1",
              [c.runId],
            );
          if (scenario === "candidate")
            await pool.query(
              "UPDATE factory_candidates SET sha=$2 WHERE id=$1",
              [c.x.task.candidateId, "b".repeat(40)],
            );
          if (scenario === "token-expiry")
            await pool.query(
              "UPDATE run_tokens SET \"expiresAt\"=clock_timestamp()-interval '1 second' WHERE id=$1",
              [c.tokenId],
            );
          if (scenario === "token")
            await pool.query(
              'UPDATE run_tokens SET "revokedAt"=clock_timestamp() WHERE id=$1',
              [c.tokenId],
            );
          if (scenario === "stop")
            await pool.query(
              'UPDATE agent_runs SET "stopRequestedAt"=clock_timestamp() WHERE id=$1',
              [c.runId],
            );
          if (scenario === "lease")
            await pool.query(
              "UPDATE agent_runs SET \"leaseExpiresAt\"=clock_timestamp()-interval '1 second' WHERE id=$1",
              [c.runId],
            );
          if (scenario === "assignment")
            await pool.query(
              'UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1',
              [c.runId, JSON.stringify({ changed: true })],
            );
          if (scenario === "policy")
            await pool.query(
              "UPDATE factory_policy_fixture SET revision='2' WHERE \"runId\"=$1",
              [c.runId],
            );
          if (scenario === "policy-target")
            await pool.query(
              'UPDATE factory_policy_fixture SET "scopeDigest"=$2 WHERE "runId"=$1',
              [c.runId, "e".repeat(64)],
            );
          if (scenario === "registration")
            await pool.query(
              'UPDATE factory_policy_fixture SET "permissionAction"=\'network\' WHERE "runId"=$1',
              [c.runId],
            );
          if (scenario === "check")
            await pool.query('DELETE FROM factory_events WHERE "taskId"=$1', [
              c.x.task.id,
            ]);
          if (scenario === "readonly")
            await pool.query(
              'UPDATE factory_policy_fixture SET "readOnly"=true WHERE "runId"=$1',
              [c.runId],
            );
          if (scenario === "readonly-run")
            await pool.query(
              "UPDATE agent_runs SET kind='acceptance' WHERE id=$1",
              [c.runId],
            );
          if (scenario === "device")
            await pool.query(
              'UPDATE devices SET enabled=false WHERE id=(SELECT "deviceId" FROM agent_runs WHERE id=$1)',
              [c.runId],
            );
          if (scenario === "missing-policy") c.state.policyAvailable = false;
          await assert.rejects(
            () => c.publication(),
            (e) =>
              e instanceof FactoryError &&
              (scenario === "candidate"
                ? e.code === "factoryEvidenceMismatch"
                : e.code.startsWith("factoryPolicy")),
          );
          assert.equal((await readdir(c.root)).length, 0);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM factory_approvals WHERE "taskId"=$1',
                [c.x.task.id],
              )
            ).rows[0].n,
            0,
          );
        }
      },
    );
    await t.test(
      "registered ask reuses its existing exact live confirmation; deny never becomes ask",
      async () => {
        const c = await fixture();
        await pool.query(
          "UPDATE factory_policy_fixture SET decision='ask' WHERE \"runId\"=$1",
          [c.runId],
        );
        await rejects(
          () => c.publication(),
          "factoryPolicyConfirmationRequired",
        );
        await pool.query(
          "INSERT INTO factory_confirmation_fixture VALUES($1,$2)",
          [
            c.credentialId,
            JSON.stringify({
              decisionId: c.credentialId,
              ownerId: actor.userId,
              sessionId: f.actor.sessionId,
              scopeDigest: digest(c.scope),
              confirmedAt: new Date().toISOString(),
              expiresAt: c.request.expiresAt,
            }),
          ],
        );
        const p = await c.publication();
        assert.ok(await c.runtime.approvals.publish(actor, p));
        const d = await fixture();
        await pool.query(
          "UPDATE factory_policy_fixture SET decision='deny' WHERE \"runId\"=$1",
          [d.runId],
        );
        await rejects(() => d.publication(), "factoryPolicyDenied");
        assert.equal((await readdir(d.root)).length, 0);
      },
    );
    await t.test(
      "review-key revocation at the final write boundary leaves reservation uncertain and cannot replay an effect",
      async () => {
        const c = await fixture(),
          p = await c.publication();
        c.state.waitBeforeWrite = async () => {
          c.state.keyAvailable = false;
        };
        await rejects(
          () => c.runtime.approvals.publish(actor, p),
          "factoryPolicyDecisionUnavailable",
        );
        assert.equal((await readdir(c.root)).length, 0);
        c.state.keyAvailable = true;
        c.state.waitBeforeWrite = undefined;
        await rejects(
          () => c.runtime.approvals.publish(actor, p),
          "factoryPublicationAlreadyClaimed",
        );
        assert.equal((await readdir(c.root)).length, 0);
      },
    );
    await t.test(
      "grant revocation and token/candidate substitution cannot reuse a signed review",
      async () => {
        const c = await fixture(),
          p = await c.publication();
        await c.runtime.approvals.revoke(actor, {
          binding: p.binding,
          approvalId: p.approvalId,
          eventId: randomUUID(),
        });
        await rejects(
          () => c.runtime.approvals.publish(actor, p),
          "factoryApprovalInvalid",
        );
        assert.equal((await readdir(c.root)).length, 0);
        const d = await fixture(),
          tx = await pool.connect();
        try {
          await tx.query("BEGIN");
          await rejects(
            () =>
              d.runtime.authority.verify(tx, d.credentialId, {
                ...d.scope,
                target: "different-target",
              }),
            "factoryPolicyDecisionMismatch",
          );
          await tx.query("ROLLBACK");
        } finally {
          tx.release();
        }
      },
    );
  } finally {
    for (const root of directories)
      await rm(root, { recursive: true, force: true });
  }
}
