import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { factoryPublicationJudgment } from "../../lib/factory/decision-execution";
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
import { createFactoryRunReviewIssuer } from "../../lib/factory/run-review-issuer";
import { readFactoryPublicationRequirements } from "../../lib/factory/publication-requirements";
import { invokeFactoryPublicationDecision } from "../../lib/factory/publication-invocation";

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
  async function fixture(
    options: {
      checkEvents?: boolean;
      sourceIssueNull?: boolean;
      /** Warp-aligned default: no crypto issuer, review is advisory. */
      advisory?: boolean;
    } = {},
  ) {
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
    if (options.sourceIssueNull)
      await pool.query(
        'UPDATE coordinator_events SET "issueId"=NULL WHERE id=$1',
        [metadata.sourceEventId],
      );
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
      // Keep signed references even when the fresh missing-event task never
      // establishes the corresponding persisted finish events.
      checks.push({
        stage,
        attemptId: a.id,
        runId: a.runId,
        sessionId: a.sessionId,
        eventId,
      });
      if (options.checkEvents === false) continue;
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
      decisionModelId: "synthetic-vision-capable-model",
      ...(options.advisory
        ? {}
        : {
            reviewKey: (issuer: string, keyId: string) =>
              state.keyAvailable &&
              issuer === "synthetic-review-transport" &&
              keyId === "ephemeral-test-key"
                ? publicKey
                : undefined,
          }),
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
    const requirementTx = await pool.connect();
    const requirements = await (async () => {
      try {
        return await readFactoryPublicationRequirements(
          requirementTx,
          { ...x.task, ...metadata },
          definition,
        );
      } finally {
        requirementTx.release();
      }
    })();
    const payload: z.infer<typeof factoryRunReview> = {
      version: 1,
      purpose: "factory-publication-review",
      credentialId,
      ownerId: actor.userId,
      executionRunId: runId,
      executionSessionId: "synthetic-executor-session",
      assignmentDigest: digest(definition),
      instructionsDigest: digest(requirements),
      policyId: "synthetic-explicit-publication",
      policyRevision: "1",
      permissionAction: "deploy_preview",
      scopeDigest: digest(scope),
      issuedAt: now.toISOString(),
      expiresAt: request.expiresAt,
      checks,
      judgment: factoryPublicationJudgment(
        {
          answers: new Map([
            [
              "publication",
              {
                type: "choice",
                name: "publication",
                choice: "publish_current",
              },
            ],
          ]),
          // Structural synthetic receipt, not a model call or provider evidence.
          execution: {
            executionId: credentialId,
            modelId: host.decisionModelId,
            providerGenerationId: "synthetic-generation",
            startedAt: now.toISOString(),
            completedAt: now.toISOString(),
            requestDigest: "a".repeat(64),
            imageDigests: [],
            vision: "no-image-input",
          },
        },
        {
          modelId: host.decisionModelId,
          requestDigest: "a".repeat(64),
          imageDigests: [],
          requiresVisual: false,
          scopeDigest: digest(scope),
          evidenceDigest: evidence.evidenceDigest,
          startedAfter: now.toISOString(),
          observedAt: now.toISOString(),
        },
      )!,
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
    // Advisory mode installs no review record at all: the policy is the only
    // authority, so nothing may depend on an envelope existing.
    if (!options.advisory)
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
    async function sourceInvocation(c: Awaited<ReturnType<typeof fixture>>) {
      const issuer = createFactoryRunReviewIssuer(f.store, c.host, {
        issuer: c.envelope.issuer,
        keyId: c.envelope.keyId,
        privateKey: () => privateKey,
      });
      const tx = await pool.connect();
      const prepared = await (async () => {
        try {
          await tx.query("BEGIN");
          const result = await issuer.prepare(tx, c.scope);
          await tx.query("COMMIT");
          return result;
        } catch (error) {
          await tx.query("ROLLBACK");
          throw error;
        } finally {
          tx.release();
        }
      })();
      assert.ok(
        prepared.observations.text.includes("Synthetic upstream result"),
      );
      const invocation = await invokeFactoryPublicationDecision(
        c.scope,
        prepared.executor,
        prepared.observations,
        {
          modelId: c.host.decisionModelId,
          serializeInput: (input) => input,
          invokeDecision: async (_purpose, input, questions) => {
            const now = new Date().toISOString();
            return {
              answers: new Map([
                [
                  "publication",
                  {
                    type: "choice",
                    name: "publication",
                    choice: "publish_current",
                  },
                ],
                [
                  "evidence_requirement",
                  {
                    type: "choice",
                    name: "evidence_requirement",
                    choice: "text_sufficient",
                  },
                ],
              ]),
              execution: {
                executionId: randomUUID(),
                modelId: c.host.decisionModelId,
                providerGenerationId: "synthetic-invocation",
                startedAt: now,
                completedAt: now,
                requestDigest: createHash("sha256")
                  .update(
                    JSON.stringify({
                      model: c.host.decisionModelId,
                      input,
                      questions,
                    }),
                  )
                  .digest("hex"),
                imageDigests: [],
                vision: "no-image-input",
              },
            };
          },
        },
      );
      assert.ok(invocation);
      return invocation;
    }
    await t.test(
      "concrete issuer signs the canonical current scope; verifier consumes its nonce through the existing event stream once (synthetic policy/model)",
      async () => {
        const c = await fixture({ sourceIssueNull: true });
        const issuer = createFactoryRunReviewIssuer(f.store, c.host, {
          issuer: c.envelope.issuer,
          keyId: c.envelope.keyId,
          privateKey: () => privateKey,
        });
        const invocation = await sourceInvocation(c);
        const tx = await pool.connect();
        let chunk: Awaited<ReturnType<typeof issuer.issue>>;
        try {
          await tx.query("BEGIN");
          chunk = await issuer.issue(tx, c.scope, invocation);
          await tx.query("COMMIT");
        } finally {
          await tx.query("ROLLBACK");
          tx.release();
        }
        assert.notEqual(chunk.data.payload.credentialId, c.credentialId);
        assert.equal(
          verify(
            null,
            factoryRunReviewSignatureInput(chunk.data.payload, chunk.data),
            publicKey,
            Buffer.from(chunk.data.signature, "base64url"),
          ),
          true,
        );
        assert.equal("decision" in chunk.data.payload, false);
        await pool.query(
          'INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,2,$3,clock_timestamp())',
          [randomUUID(), c.runId, JSON.stringify(chunk)],
        );
        const granted = await c.runtime.approvals.approve(actor, {
          ...c.request,
          decisionCredentialId: chunk.data.payload.credentialId,
        });
        const p = {
          ...granted,
          eventId: randomUUID(),
          action: c.request.action,
          target: c.request.target,
          targetEnvironment: c.request.targetEnvironment,
        };
        const published = await c.runtime.approvals.publish(actor, p);
        assert.ok(published);
        assert.equal(
          (await c.runtime.approvals.publish(actor, p))?.publicationId,
          published.publicationId,
        );
        assert.equal((await readdir(c.root)).length, 1);
      },
    );
    await t.test(
      "issuer deny reads no private key; ask review remains ungranted without its existing exact confirmation (synthetic policy/model)",
      async () => {
        const c = await fixture();
        let keyReads = 0;
        const invocation = await sourceInvocation(c);
        const issuer = createFactoryRunReviewIssuer(f.store, c.host, {
          issuer: c.envelope.issuer,
          keyId: c.envelope.keyId,
          privateKey: () => {
            keyReads++;
            return privateKey;
          },
        });
        const invoke = async () => {
          const tx = await pool.connect();
          try {
            await tx.query("BEGIN");
            return await issuer.issue(tx, c.scope, invocation);
          } finally {
            await tx.query("ROLLBACK");
            tx.release();
          }
        };
        await pool.query(
          "UPDATE factory_policy_fixture SET decision='deny' WHERE \"runId\"=$1",
          [c.runId],
        );
        await rejects(invoke, "factoryPolicyDenied");
        assert.equal(keyReads, 0);
        await pool.query(
          "UPDATE factory_policy_fixture SET decision='ask' WHERE \"runId\"=$1",
          [c.runId],
        );
        const chunk = await invoke();
        assert.equal("decision" in chunk.data.payload, false);
        await pool.query(
          'INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,2,$3,clock_timestamp())',
          [randomUUID(), c.runId, JSON.stringify(chunk)],
        );
        await rejects(
          () =>
            c.runtime.approvals.approve(actor, {
              ...c.request,
              decisionCredentialId: chunk.data.payload.credentialId,
            }),
          "factoryPolicyConfirmationRequired",
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
          "instructions",
          "source-kind",
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
          "check-result",
          "readonly",
          "readonly-run",
          "device",
          "missing-policy",
          "model-selection",
          "model-request",
          "model-future",
          "model-visual",
          "model-receipt",
          "model-defer",
        ]) {
          const c = await fixture({ checkEvents: scenario !== "check" });
          if (scenario === "check") {
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::int AS n FROM factory_events WHERE "taskId"=$1',
                  [c.x.task.id],
                )
              ).rows[0].n,
              0,
            );
          }
          if (scenario === "signature") c.envelope.signature = "A".repeat(86);
          if (scenario === "instructions")
            await pool.query(
              "UPDATE issues SET content=$2,revision=revision+1 WHERE id=$1",
              [
                c.x.task.issueId,
                JSON.stringify({
                  text: "Changed task requirements after review",
                }),
              ],
            );
          if (scenario === "source-kind")
            await pool.query(
              "UPDATE coordinator_events SET kind='run_report' WHERE id=(SELECT \"sourceEventId\" FROM factory_tasks WHERE id=$1)",
              [c.x.task.id],
            );
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
          if (scenario === "model-selection")
            c.host.decisionModelId = "different-host-model";
          if (scenario.startsWith("model-") && scenario !== "model-selection") {
            const judgment = c.envelope.payload.judgment;
            if (scenario === "model-request")
              judgment.requestDigest = "e".repeat(64);
            if (scenario === "model-future")
              judgment.execution.completedAt = "2099-01-01T00:00:00.000Z";
            if (scenario === "model-visual")
              judgment.visualInputRequired = true;
            if (scenario === "model-receipt") judgment.receiptId = randomUUID();
            if (scenario === "model-defer")
              Object.assign(judgment, { choice: "defer" });
            // Invalid defer is rejected by the signer schema too. Persist it
            // with the old signature to exercise the reader's parse rejection.
            if (scenario !== "model-defer")
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
            ].includes(scenario) ||
            scenario.startsWith("model-")
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
          if (scenario === "check-result")
            await pool.query(
              `UPDATE factory_events SET result='{"invalidSyntheticCheck":true}'::jsonb WHERE "taskId"=$1`,
              [c.x.task.id],
            );
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
                : e.code.startsWith("factoryPolicy")) &&
              (scenario !== "check" ||
                e.code === "factoryPolicyCheckReceiptRequired"),
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
      "issue/source requirements changed after grant cannot reuse the old model judgment for publication",
      async () => {
        for (const field of ["issue", "source"] as const) {
          const c = await fixture();
          const granted = await c.runtime.approvals.approve(actor, c.request);
          if (field === "issue")
            await pool.query(
              "UPDATE issues SET content=$2,revision=revision+1 WHERE id=$1",
              [
                c.x.task.issueId,
                JSON.stringify({
                  text: "Changed acceptance criteria after grant",
                }),
              ],
            );
          else
            await pool.query(
              'UPDATE coordinator_events SET payload=$2 WHERE id=(SELECT "sourceEventId" FROM factory_tasks WHERE id=$1)',
              [
                c.x.task.id,
                JSON.stringify({
                  text: "Changed originating request after grant",
                }),
              ],
            );
          const p = {
            ...granted,
            eventId: randomUUID(),
            action: c.request.action,
            target: c.request.target,
            targetEnvironment: c.request.targetEnvironment,
          };
          await rejects(
            () => c.runtime.approvals.publish(actor, p),
            "factoryPolicyDecisionMismatch",
          );
          assert.equal((await readdir(c.root)).length, 0);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM factory_publications WHERE "taskId"=$1',
                [c.x.task.id],
              )
            ).rows[0].n,
            0,
          );
        }
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
    await t.test(
      "advisory mode publishes a preview from the registered policy and passed checks with no review key or envelope",
      async () => {
        const c = await fixture({ advisory: true }),
          p = await c.publication();
        const published = await c.runtime.approvals.publish(actor, p);
        assert.ok(published);
        assert.equal((await readdir(c.root)).length, 1);
        const grant = (
          await pool.query(
            'SELECT "decisionEvidence" FROM factory_approvals WHERE id=$1',
            [p.approvalId],
          )
        ).rows[0].decisionEvidence;
        assert.equal(grant.verification.attestation, "advisory");
        assert.equal(grant.verification.signatureDigest, undefined);
        assert.equal(grant.verification.runBinding, undefined);
        assert.equal(grant.issuer, "factory-host-policy");
        assert.equal(grant.judgment, undefined);
        assert.equal(grant.decision, "allow");
      },
    );
    await t.test(
      "advisory mode cannot be steered by an agent-written review envelope or a registered deny",
      async () => {
        const c = await fixture({ advisory: true });
        await pool.query(
          'INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,1,$3,clock_timestamp())',
          [
            randomUUID(),
            c.runId,
            JSON.stringify({
              type: "data-factory-publication-review",
              data: { ...c.envelope, signature: undefined },
            }),
          ],
        );
        await pool.query(
          "UPDATE factory_policy_fixture SET decision='deny' WHERE \"runId\"=$1",
          [c.runId],
        );
        await rejects(
          () => c.runtime.approvals.approve(actor, c.request),
          "factoryPolicyDenied",
        );
        await pool.query(
          'UPDATE factory_policy_fixture SET "readOnly"=true,decision=\'allow\' WHERE "runId"=$1',
          [c.runId],
        );
        await rejects(
          () => c.runtime.approvals.approve(actor, c.request),
          "factoryPolicyDenied",
        );
        assert.equal((await readdir(c.root)).length, 0);
      },
    );
    await t.test(
      "no mode authorizes a merge, and advisory mode requires an attestation for irreversible effects",
      async () => {
        for (const advisory of [true, false]) {
          const c = await fixture({ advisory });
          await rejects(
            () =>
              c.runtime.approvals.approve(actor, {
                ...c.request,
                action: "merge",
              }),
            "factoryPolicyDenied",
          );
          for (const action of ["deploy_production", "activate_skill"] as const)
            await rejects(
              () =>
                c.runtime.approvals.approve(actor, {
                  ...c.request,
                  action,
                }),
              advisory
                ? "factoryPolicyAttestationRequired"
                : "factoryPolicyDecisionMismatch",
            );
          assert.equal((await readdir(c.root)).length, 0);
        }
      },
    );
  } finally {
    for (const root of directories)
      console.info("Factory194 retained artifact directory", root);
  }
}
