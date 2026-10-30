import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { factory194Fixture } from "../../tests/helpers/factory194";
import { factoryRunAuthorityCases } from "../../tests/helpers/factory194-run-authority";
import { factory194Target } from "../../tests/helpers/factory194-target";
import { FactoryError } from "./approval-contract";
import { handleFactoryApproval } from "./approval-http";
import {
  PublicationDeferred,
  publicationBindingHash,
} from "./publication-operation";
import {
  createVercelPublicationAdapter,
  MIKKA_VERCEL,
} from "./vercel-publication";
import {
  readFactoryPublicationReceiptV2,
  readFactoryPublicationReceipt,
} from "./publication-receipt";

const ci = process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true";
const db =
  process.env.FACTORY194_TEST_URL ??
  (ci ? process.env.E2E_DATABASE_URL : undefined);
if (process.env.REQUIRE_DB === "1" && !db)
  throw new Error(
    "Factory approval DB test requires an explicit disposable database",
  );
if (db) {
  factory194Target(db, ci);
}
const rejects = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(fn, (e) => e instanceof FactoryError && e.code === code);
test(
  "isolated PG17 approval/publisher port contract; upstream/store/OAuth/provider are substitutes",
  { skip: !db, timeout: 120000 },
  async (t) => {
    const f = await factory194Fixture(db!);
    try {
      const { actor, pool, provider } = f;
      await factoryRunAuthorityCases(t, f);
      await t.test(
        "a live browser session approves and publishes without any decision authority",
        async () => {
          const x = await f.prepare(),
            human = { ...x.approval } as Record<string, unknown>,
            service = f.service([f.adapter], null),
            before = provider.posts();
          delete human.decisionCredentialId;
          const approved = await service.approve(actor, human);
          const published = await service.publish(actor, {
            ...approved,
            eventId: randomUUID(),
            action: x.approval.action,
            target: x.approval.target,
            targetEnvironment: x.approval.targetEnvironment,
          });
          assert.ok(published?.receipt);
          assert.equal(provider.posts(), before + 1);
          const grant = (
            await pool.query(
              'SELECT "humanSessionId","decisionCredentialId","decisionScope","decisionEvidence" FROM factory_approvals WHERE id=$1',
              [approved.approvalId],
            )
          ).rows[0];
          assert.equal(grant.humanSessionId, actor.sessionId);
          assert.equal(grant.decisionCredentialId, null);
          assert.equal(grant.decisionScope, null);
          assert.equal(grant.decisionEvidence, null);
          const next = await f.prepare(),
            nextHuman = { ...next.approval } as Record<string, unknown>;
          delete nextHuman.decisionCredentialId;
          await pool.query(
            `UPDATE "session" SET "expiresAt"=now()-interval '1 second' WHERE id=$1`,
            [actor.sessionId],
          );
          try {
            await rejects(
              () => service.approve(actor, nextHuman),
              "factoryHumanRequired",
            );
          } finally {
            await pool.query(
              `UPDATE "session" SET "expiresAt"=now()+interval '1 hour' WHERE id=$1`,
              [actor.sessionId],
            );
          }
        },
      );
      await t.test(
        "A3: a run capture is evidence by reference; the digest binds its file sha256",
        async () => {
          const x = await f.prepare(actor, { capture: true }),
            service = f.service([f.adapter], null),
            captureId = x.captureId!;
          const read = await service.evidence(actor, x.task.id);
          const entry = read.manifest.artifacts.find(
            (a) => "captureId" in a && a.captureId === captureId,
          ) as Record<string, unknown> | undefined;
          assert.ok(entry, "the manifest names the capture");
          assert.equal(entry.artifact, `run-capture:${captureId}`);
          assert.equal(entry.kind, "screenshot");
          assert.equal(entry.stage, "verify");
          assert.equal(entry.sha256, "e".repeat(64), "the file's own sha256, not a digest of metadata");
          assert.equal(entry.contentType, "image/png");
          // Text entries keep their historical shape (existing approvals keep matching).
          const report = read.manifest.artifacts.find((a) => a.kind === "report")!;
          assert.equal("captureId" in report, false);
          assert.deepEqual(await service.capture(actor, x.task.id, captureId), {
            ownerId: actor.userId,
            captureId,
            sha256: "e".repeat(64),
          });
          await rejects(() => service.capture(actor, x.task.id, randomUUID()), "factoryArtifactMissing");
          await rejects(
            () => service.capture({ userId: "someone-else", sessionId: actor.sessionId }, x.task.id, captureId),
            "factoryNotFound",
          );
          const human = { ...x.approval } as Record<string, unknown>;
          delete human.decisionCredentialId;
          // Swapping the file after the read invalidates the read.
          await pool.query("UPDATE run_captures SET sha256=$2 WHERE id=$1", [captureId, "f".repeat(64)]);
          await rejects(() => service.approve(actor, human), "factoryEvidenceMismatch");
          const swapped = await service.evidence(actor, x.task.id);
          assert.notEqual(swapped.evidenceDigest, read.evidenceDigest);
          // An approval binds the evidence the reviewer saw; a later swap voids it at publish.
          const approved = await service.approve(actor, {
            ...human,
            eventId: randomUUID(),
            evidenceDigest: swapped.evidenceDigest,
            evidenceReadId: swapped.evidenceReadId,
          });
          await pool.query("UPDATE run_captures SET sha256=$2 WHERE id=$1", [captureId, "e".repeat(64)]);
          await rejects(
            () =>
              service.publish(actor, {
                ...approved,
                eventId: randomUUID(),
                action: x.approval.action,
                target: x.approval.target,
                targetEnvironment: x.approval.targetEnvironment,
              }),
            "factoryApprovalInvalid",
          );
          // A capture of another run, or one no longer ready, is not evidence.
          await pool.query(`UPDATE run_captures SET status='failed' WHERE id=$1`, [captureId]);
          await rejects(() => service.capture(actor, x.task.id, captureId), "factoryArtifactMissing");
          await pool.query(`UPDATE run_captures SET status='ready',"runId"=$2 WHERE id=$1`, [captureId, randomUUID()]);
          await rejects(() => service.capture(actor, x.task.id, captureId), "factoryArtifactMissing");
        },
      );
      await t.test(
        "policy allow publishes for authenticated backend owner without any human session prerequisite",
        async () => {
          const backendActor = { userId: actor.userId },
            x = await f.prepare(backendActor);
          const p = await x.publication(),
            before = provider.posts();
          const result = await f.service().publish(backendActor, p);
          assert.ok(result);
          assert.equal(provider.posts(), before + 1);
          const grant = (
            await pool.query(
              'SELECT "humanSessionId","decisionCredentialId","decisionEvidence" FROM factory_approvals WHERE id=$1',
              [p.approvalId],
            )
          ).rows[0];
          assert.equal(grant.humanSessionId, null);
          assert.equal(
            grant.decisionCredentialId,
            x.approval.decisionCredentialId,
          );
          assert.equal(grant.decisionEvidence.decision, "allow");
          const tx = await pool.connect();
          try {
            const receipt = await readFactoryPublicationReceiptV2(
              tx,
              actor.userId,
              x.task.id,
              x.task.candidateId!,
            );
            assert.equal(receipt.publicationId, result.publicationId);
            assert.equal(
              receipt.verifiedTarget.provider?.bindingHash,
              result.receipt.verifiedTarget.provider?.bindingHash,
            );
            const forged = structuredClone(grant.decisionEvidence);
            forged.verification.signatureDigest = "e".repeat(64);
            await pool.query(
              'UPDATE factory_approvals SET "decisionEvidence"=$2 WHERE id=$1',
              [p.approvalId, JSON.stringify(forged)],
            );
            await rejects(
              () =>
                readFactoryPublicationReceiptV2(
                  tx,
                  actor.userId,
                  x.task.id,
                  x.task.candidateId!,
                ),
              "factoryPublicationReceiptRequired",
            );
            await pool.query(
              'UPDATE factory_approvals SET "decisionEvidence"=NULL WHERE id=$1',
              [p.approvalId],
            );
            await rejects(
              () =>
                readFactoryPublicationReceiptV2(
                  tx,
                  actor.userId,
                  x.task.id,
                  x.task.candidateId!,
                ),
              "factoryPublicationReceiptRequired",
            );
          } finally {
            // Keep the invalid synthetic evidence for inspection; never restore.
            tx.release();
          }
        },
      );
      await t.test(
        "only existing policy ask needs its decision-bound confirmation; deny and missing authority never become a second human fallback",
        async () => {
          const backendActor = { userId: actor.userId },
            before = provider.posts();
          for (const mode of ["ask", "deny"] as const) {
            const x = await f.prepare(backendActor),
              d = f.decisions.get(x.approval.decisionCredentialId)!;
            d.decision = mode;
            await rejects(
              () => x.approve(),
              mode === "ask"
                ? "factoryPolicyConfirmationRequired"
                : "factoryPolicyDenied",
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::int AS n FROM factory_approvals WHERE "taskId"=$1',
                  [x.task.id],
                )
              ).rows[0].n,
              0,
            );
            if (mode === "ask") {
              d.confirmation = {
                decisionId: d.credentialId,
                ownerId: actor.userId,
                sessionId: actor.sessionId,
                scopeDigest: d.scopeDigest,
                confirmedAt: new Date().toISOString(),
                expiresAt: d.expiresAt,
              };
              const p = await x.publication();
              assert.ok(p.approvalId);
              assert.equal(
                (
                  await pool.query(
                    'SELECT "humanSessionId" FROM factory_approvals WHERE id=$1',
                    [p.approvalId],
                  )
                ).rows[0].humanSessionId,
                actor.sessionId,
              );
            }
          }
          const x = await f.prepare(backendActor);
          await rejects(
            () => f.service(undefined, null).approve(backendActor, x.approval),
            "factoryPolicyDecisionUnavailable",
          );
          await rejects(
            () =>
              f
                .service()
                .approve(backendActor, { ...x.approval, decision: "allow" }),
            "factoryInvalid",
          );
          assert.equal(provider.posts(), before);
        },
      );
      await t.test(
        "one policy credential cannot create another grant, move to another task or repeat an effect",
        async () => {
          const backendActor = { userId: actor.userId },
            x = await f.prepare(backendActor);
          const first = await x.approve(),
            again = await x.approve();
          assert.equal(first.approvalId, again.approvalId);
          await rejects(
            () =>
              f.service().approve(backendActor, {
                ...x.approval,
                eventId: randomUUID(),
              }),
            "factoryStale",
          );
          const other = await f.prepare(backendActor);
          await rejects(
            () =>
              f.service().approve(backendActor, {
                ...other.approval,
                decisionCredentialId: x.approval.decisionCredentialId,
              }),
            "factoryPolicyDecisionMismatch",
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM factory_approvals WHERE "decisionCredentialId"=$1',
                [x.approval.decisionCredentialId],
              )
            ).rows[0].n,
            1,
          );
          // The existing grant table itself enforces the one-credential invariant.
          await assert.rejects(
            () =>
              pool.query(
                `INSERT INTO factory_approvals SELECT $1,"taskId","candidateId","attemptId","userId","principalId","humanSessionId","decisionCredentialId","decisionScope","decisionEvidence",$2,request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt","revokedAt","createdAt" FROM factory_approvals WHERE id=$3`,
                [randomUUID(), randomUUID(), first.approvalId],
              ),
            (e: unknown) =>
              e instanceof Error && "code" in e && e.code === "23505",
          );
        },
      );
      await t.test(
        "policy revoked during provider project preflight prevents POST without asking a human again",
        async () => {
          const backendActor = { userId: actor.userId },
            x = await f.prepare(backendActor),
            p = await x.publication();
          const before = provider.posts(),
            requestCount = provider.requests.length;
          provider.state.projectDelayMs = 250;
          const pending = f.service().publish(backendActor, p);
          try {
            for (
              let i = 0;
              i < 100 && provider.requests.length === requestCount;
              i++
            )
              await new Promise((r) => setTimeout(r, 5));
            assert.ok(provider.requests.length > requestCount);
            f.decisions.get(x.approval.decisionCredentialId)!.decision = "deny";
            await rejects(() => pending, "factoryPolicyDenied");
            assert.equal(provider.posts(), before);
          } finally {
            provider.state.projectDelayMs = 0;
          }
        },
      );
      await t.test(
        "upstream locked Bot/source authorization also guards reads and pre-publication",
        async () => {
          const x = await f.prepare(),
            p = await x.publication(),
            s = f.service();
          const before = provider.posts();
          f.source.allowed = false;
          try {
            await rejects(
              () => s.evidence(actor, x.task.id),
              "factoryNotFound",
            );
            await rejects(() => s.ledger(actor, x.task.id), "factoryNotFound");
            await rejects(() => s.publish(actor, p), "factoryNotFound");
            await rejects(
              () => s.reconcile(actor, { ...p, publicationId: randomUUID() }),
              "factoryNotFound",
            );
            assert.equal(provider.posts(), before);
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::int AS n FROM factory_publications WHERE "taskId"=$1',
                  [x.task.id],
                )
              ).rows[0].n,
              0,
            );
          } finally {
            f.source.allowed = true;
          }
        },
      );
      await t.test(
        "exact approval read, owner, SHA/scope/environment/digest/expiry and concurrent replay",
        async () => {
          const x = await f.prepare(),
            s = f.service();
          await rejects(
            () =>
              s.approve(actor, {
                ...x.approval,
                actor: { userId: actor.userId, sessionId: actor.sessionId },
              }),
            "factoryInvalid",
          );
          for (const patch of [
            { candidate: { ...x.candidate, sha: "b".repeat(40) } },
            { candidate: { ...x.candidate, scope: "expanded" } },
            { candidate: { ...x.candidate, environment: "production" } },
            { evidenceDigest: "0".repeat(64) },
            { evidenceReadId: randomUUID() },
          ])
            await rejects(
              () => s.approve(actor, { ...x.approval, ...patch }),
              "factoryEvidenceMismatch",
            );
          await rejects(
            () => s.approve({ ...actor, userId: "foreign" }, x.approval),
            "factoryNotFound",
          );
          await rejects(
            () =>
              s.approve(actor, {
                ...x.approval,
                expiresAt: new Date(Date.now() - 1000).toISOString(),
              }),
            "factoryApprovalExpiry",
          );
          const approvals = await Promise.all(
            Array.from({ length: 10 }, () => s.approve(actor, x.approval)),
          );
          assert.equal(new Set(approvals.map((a) => a.approvalId)).size, 1);
          await rejects(
            () => s.approve(actor, { ...x.approval, target: "changed-target" }),
            "factoryReplayMismatch",
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*) FROM factory_approvals WHERE "taskId"=$1',
                [x.task.id],
              )
            ).rows[0].count,
            "1",
          );
        },
      );
      await t.test(
        "concurrent publication, V2 provenance, owner isolation, and current #192 fence",
        async () => {
          const x = await f.prepare(),
            p = await x.publication(),
            s = f.service(),
            before = provider.posts();
          const results = await Promise.allSettled(
            Array.from({ length: 10 }, () => s.publish(actor, p)),
          );
          assert.ok(results.some((r) => r.status === "fulfilled"));
          assert.equal(provider.posts(), before + 1);
          const result = await s.publish(actor, p);
          assert.ok(result);
          const tx = await pool.connect();
          try {
            const receipt = await readFactoryPublicationReceiptV2(
              tx,
              actor.userId,
              x.task.id,
              x.task.candidateId!,
            );
            assert.equal(receipt.version, 2);
            assert.equal(receipt.action, p.action);
            assert.equal(receipt.candidate.sha, x.candidate.sha);
            assert.equal(receipt.targetEnvironment, "preview");
            assert.equal(
              receipt.verifiedTarget.provider?.publicationId,
              result.publicationId,
            );
            assert.equal(
              (
                await readFactoryPublicationReceipt(
                  tx,
                  actor.userId,
                  x.task.id,
                  x.task.candidateId!,
                )
              ).version,
              1,
            );
            await rejects(
              () =>
                readFactoryPublicationReceiptV2(
                  tx,
                  "foreign",
                  x.task.id,
                  x.task.candidateId!,
                ),
              "factoryPublicationReceiptRequired",
            );
            await pool.query(
              "UPDATE factory_publications SET action='deploy_production' WHERE id=$1",
              [result.publicationId],
            );
            await rejects(
              () =>
                readFactoryPublicationReceiptV2(
                  tx,
                  actor.userId,
                  x.task.id,
                  x.task.candidateId!,
                ),
              "factoryPublicationReceiptRequired",
            );
          } finally {
            tx.release();
          }
          await pool.query(
            "UPDATE factory_tasks SET revision=revision+1 WHERE id=$1",
            [x.task.id],
          );
          await rejects(() => s.publish(actor, p), "factoryStale");
          assert.equal(provider.posts(), before + 1);
        },
      );
      await t.test(
        "V2 production envelope and missing/uncertain receipts for #195",
        async () => {
          const x = await f.prepare(),
            adapter = createVercelPublicationAdapter(
              { ...MIKKA_VERCEL, environment: "production" },
              provider.client,
            ),
            s = f.service([adapter]);
          provider.state.readyState = "READY";
          const a = await s.approve(
            actor,
            f.issuePolicyDecision({
              ...x.approval,
              action: "deploy_production",
              target: adapter.target,
              targetEnvironment: "production",
            }),
          );
          const result = await s.publish(actor, {
            ...a,
            eventId: randomUUID(),
            action: "deploy_production",
            target: adapter.target,
            targetEnvironment: "production",
          });
          assert.ok(result);
          const tx = await pool.connect();
          try {
            const receipt = await readFactoryPublicationReceiptV2(
              tx,
              actor.userId,
              x.task.id,
              x.task.candidateId!,
            );
            assert.equal(receipt.action, "deploy_production");
            assert.equal(receipt.targetEnvironment, "production");
            assert.equal(receipt.verifiedTarget.kind, "production-deployment");
            assert.equal(receipt.verifiedTarget.environment, "production");
            assert.equal(
              receipt.candidate.environment,
              x.candidate.environment,
            );
            assert.equal(
              receipt.verifiedTarget.operationId,
              receipt.verifiedTarget.provider?.deploymentId,
            );
            assert.equal(
              receipt.verifiedTarget.provider?.publicationId,
              result.publicationId,
            );
            assert.equal(
              receipt.verifiedTarget.provider?.teamId,
              MIKKA_VERCEL.teamId,
            );
            assert.equal(
              receipt.verifiedTarget.provider?.projectId,
              MIKKA_VERCEL.projectId,
            );
            assert.match(
              receipt.verifiedTarget.provider!.bindingHash,
              /^[a-f0-9]{64}$/,
            );
            assert.ok(
              Date.parse(receipt.publishedAt) >=
                Date.parse(receipt.verifiedTarget.observedAt),
            );
            await rejects(
              () =>
                readFactoryPublicationReceipt(
                  tx,
                  actor.userId,
                  x.task.id,
                  x.task.candidateId!,
                ),
              "factoryPublicationReceiptRequired",
            );
            await pool.query(
              "UPDATE factory_publications SET status='uncertain' WHERE id=$1",
              [result.publicationId],
            );
            await rejects(
              () =>
                readFactoryPublicationReceiptV2(
                  tx,
                  actor.userId,
                  x.task.id,
                  x.task.candidateId!,
                ),
              "factoryPublicationReceiptRequired",
            );
            await pool.query(
              "UPDATE factory_publications SET status='succeeded',receipt=receipt #- '{verifiedTarget,provider}' WHERE id=$1",
              [result.publicationId],
            );
            await assert.rejects(
              () =>
                readFactoryPublicationReceiptV2(
                  tx,
                  actor.userId,
                  x.task.id,
                  x.task.candidateId!,
                ),
              /factoryPublicationReceipt/,
            );
          } finally {
            tx.release();
          }
        },
      );
      for (const window of ["queued", "lost-response", "sql-rollback"] as const)
        await t.test(
          `durable ${window}; reconnect performs GET reconciliation only`,
          async () => {
            const x = await f.prepare(),
              p = await x.publication(),
              before = provider.posts();
            provider.state.readyState =
              window === "queued" ? "BUILDING" : "READY";
            provider.state.dropCreateResponse = window === "lost-response";
            if (window === "sql-rollback")
              await pool.query(
                `CREATE FUNCTION reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('factory194.inject_failure',true) IS DISTINCT FROM 'off' THEN RAISE EXCEPTION 'injected rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_event BEFORE INSERT ON factory_events FOR EACH ROW WHEN (NEW."taskId"='${x.task.id}'::uuid) EXECUTE FUNCTION reject_event()`,
              );
            await assert.rejects(
              () => f.service().publish(actor, p),
              window === "sql-rollback"
                ? /injected rollback/
                : (e: unknown) => e instanceof PublicationDeferred,
            );
            if (window === "sql-rollback")
              await pool.query(
                "ALTER FUNCTION reject_event() SET factory194.inject_failure='off'",
              );
            assert.equal(provider.posts(), before + 1);
            const ledger = await f.service().ledger(actor, x.task.id),
              op = ledger.publications[0];
            assert.equal(
              op.status,
              window === "queued" ? "reserved" : "uncertain",
            );
            await rejects(
              () => f.service().publish(actor, p),
              "factoryPublicationAlreadyClaimed",
            );
            for (const d of provider.deployments.values())
              d.readyState = "READY";
            provider.state.dropCreateResponse = false;
            const results = await Promise.all(
              Array.from({ length: 5 }, () =>
                f.service().reconcile(actor, { ...p, publicationId: op.id }),
              ),
            );
            assert.ok(results.every((r) => r.publicationId === op.id));
            assert.equal(provider.posts(), before + 1);
          },
        );
      await t.test(
        "expiry/revocation/session sign-out/new candidate/failing verify/wrong destination make zero POST",
        async () => {
          for (const scenario of [
            "expired",
            "revoked",
            "session",
            "candidate",
            "verify",
            "target",
            "environment",
            "action",
          ]) {
            const x = await f.prepare(),
              p = await x.publication(),
              s = f.service(),
              before = provider.posts();
            if (scenario === "expired")
              await pool.query(
                "UPDATE factory_approvals SET \"expiresAt\"=now()-interval '1 minute' WHERE id=$1",
                [p.approvalId],
              );
            if (scenario === "revoked")
              await s.revoke(actor, {
                binding: p.binding,
                approvalId: p.approvalId,
                eventId: randomUUID(),
              });
            if (scenario === "session")
              await pool.query(
                'UPDATE "session" SET "expiresAt"=now()-interval \'1 minute\' WHERE id=$1',
                [actor.sessionId],
              );
            if (scenario === "candidate")
              await pool.query(
                "UPDATE factory_candidates SET sha=$2 WHERE id=$1",
                [x.task.candidateId, "c".repeat(40)],
              );
            if (scenario === "verify")
              await pool.query(
                "UPDATE factory_attempts SET status='failed' WHERE \"taskId\"=$1 AND stage='verify'",
                [x.task.id],
              );
            const patch =
              scenario === "target"
                ? { target: "wrong" }
                : scenario === "environment"
                  ? { targetEnvironment: "production" }
                  : scenario === "action"
                    ? { action: "deploy_production" }
                    : {};
            await assert.rejects(() => s.publish(actor, { ...p, ...patch }));
            assert.equal(provider.posts(), before);
            await pool.query(
              'UPDATE "session" SET "expiresAt"=now()+interval \'1 hour\' WHERE id=$1',
              [actor.sessionId],
            );
          }
        },
      );
      await t.test(
        "permission revoked during project preflight prevents POST",
        async () => {
          const x = await f.prepare(),
            p = await x.publication(),
            before = provider.posts();
          provider.state.projectDelayMs = 250;
          const requestCount = provider.requests.length,
            publish = f.service().publish(actor, p);
          try {
            for (
              let i = 0;
              i < 100 && provider.requests.length === requestCount;
              i++
            )
              await new Promise((resolve) => setTimeout(resolve, 5));
            assert.ok(provider.requests.length > requestCount);
            f.permission.allowed = false;
            await rejects(() => publish, "factoryNotFound");
            assert.equal(provider.posts(), before);
          } finally {
            f.permission.allowed = true;
            provider.state.projectDelayMs = 0;
          }
        },
      );
      await t.test(
        "grant/session expiration during project preflight prevents POST",
        async () => {
          const before = provider.posts();
          provider.state.projectDelayMs = 2500;
          try {
            for (const field of ["approval", "session"]) {
              const x = await f.prepare();
              if (field === "approval")
                x.approval.expiresAt = new Date(
                  Date.now() + 2000,
                ).toISOString();
              Object.assign(x.approval, f.issuePolicyDecision(x.approval));
              const p = await x.publication();
              if (field === "session")
                await pool.query(
                  'UPDATE "session" SET "expiresAt"=now()+interval \'2 seconds\' WHERE id=$1',
                  [actor.sessionId],
                );
              try {
                await rejects(
                  () => f.service().publish(actor, p),
                  field === "approval"
                    ? "factoryApprovalInvalid"
                    : "factoryHumanRequired",
                );
                assert.equal(provider.posts(), before);
              } finally {
                await pool.query(
                  'UPDATE "session" SET "expiresAt"=now()+interval \'1 hour\' WHERE id=$1',
                  [actor.sessionId],
                );
              }
            }
          } finally {
            provider.state.projectDelayMs = 0;
          }
        },
      );
      await t.test(
        "historical receipt survives consumed expiry; replay/revocation never resurrect a grant",
        async () => {
          provider.state.readyState = "READY";
          const x = await f.prepare(),
            p = await x.publication(),
            s = f.service(),
            r = await s.publish(actor, p);
          assert.ok(r);
          await pool.query(
            "UPDATE factory_approvals SET \"expiresAt\"=now()-interval '1 minute' WHERE id=$1",
            [p.approvalId],
          );
          await rejects(() => s.publish(actor, p), "factoryApprovalInvalid");
          await rejects(
            () => s.reconcile(actor, { ...p, publicationId: r.publicationId }),
            "factoryApprovalInvalid",
          );
          const tx = await pool.connect();
          try {
            assert.equal(
              (
                await readFactoryPublicationReceiptV2(
                  tx,
                  actor.userId,
                  x.task.id,
                  x.task.candidateId!,
                )
              ).publicationId,
              r.publicationId,
            );
            await s.revoke(actor, {
              binding: r.binding,
              approvalId: p.approvalId,
              eventId: randomUUID(),
            });
            await rejects(
              () =>
                readFactoryPublicationReceiptV2(
                  tx,
                  actor.userId,
                  x.task.id,
                  x.task.candidateId!,
                ),
              "factoryPublicationReceiptRequired",
            );
          } finally {
            tx.release();
          }
        },
      );
      await t.test(
        "historical human-bound V2 remains readable and a live human session replays it without another provider call",
        async () => {
          const x = await f.prepare(),
            p = await x.publication(),
            s = f.service(),
            result = await s.publish(actor, p);
          assert.ok(result);
          const oldRequest = { ...x.approval } as Record<string, unknown>;
          delete oldRequest.decisionCredentialId;
          const legacyReceipt = structuredClone(result.receipt);
          legacyReceipt.verifiedTarget.provider!.bindingHash =
            publicationBindingHash({
              idempotencyKey: result.publicationId,
              candidate: x.candidate,
              authorization: {
                approvalId: p.approvalId,
                ownerId: actor.userId,
                humanSessionId: actor.sessionId,
                expiresAt: x.approval.expiresAt,
                binding: p.binding,
                eventId: p.eventId,
                action: p.action,
                target: p.target,
                targetEnvironment: p.targetEnvironment,
              },
            });
          await pool.query(
            'UPDATE factory_approvals SET request=$2,"humanSessionId"=$3,"decisionCredentialId"=NULL,"decisionScope"=NULL,"decisionEvidence"=NULL WHERE id=$1',
            [p.approvalId, JSON.stringify(oldRequest), actor.sessionId],
          );
          await pool.query(
            "UPDATE factory_publications SET receipt=$2 WHERE id=$1",
            [result.publicationId, JSON.stringify(legacyReceipt)],
          );
          const tx = await pool.connect();
          try {
            assert.equal(
              (
                await readFactoryPublicationReceiptV2(
                  tx,
                  actor.userId,
                  x.task.id,
                  x.task.candidateId!,
                )
              ).publicationId,
              result.publicationId,
            );
          } finally {
            tx.release();
          }
          const before = provider.posts();
          const replay = await s.publish(actor, p);
          assert.ok(replay);
          assert.equal(replay.publicationId, result.publicationId);
          assert.equal(provider.posts(), before);
        },
      );
      await t.test(
        "HTTP origin/cookie boundary and 202 pending never accept a client success receipt",
        async () => {
          const x = await f.prepare(),
            p = await x.publication(),
            s = f.service();
          provider.state.readyState = "BUILDING";
          const req = {
            actor,
            authorization: null,
            method: "POST",
            taskId: x.task.id,
            url: `https://fixture.invalid/api/factory/tasks/${x.task.id}/approval`,
            origin: "https://fixture.invalid",
            body: { operation: "publish", input: p },
          };
          assert.equal(
            (
              await handleFactoryApproval(s, {
                ...req,
                authorization: "Bearer synthetic-worker",
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await handleFactoryApproval(s, {
                ...req,
                origin: "https://other.invalid",
              })
            ).status,
            403,
          );
          const r = await handleFactoryApproval(s, req);
          assert.equal(r.status, 202);
          const op = (await s.ledger(actor, x.task.id)).publications[0];
          await rejects(
            () =>
              s.reconcile(actor, {
                ...p,
                publicationId: op.id,
                receipt: { reference: "forged" },
              }),
            "factoryInvalid",
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
