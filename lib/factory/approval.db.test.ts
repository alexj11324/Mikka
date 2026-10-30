import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { factory194Fixture } from "../../tests/helpers/factory194";
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
      await t.test('one approve HTTP request starts publication and returns pending reconciliation without a second publish', async () => {
        const x = await f.prepare(), service = f.service(), before = provider.posts();
        provider.state.readyState = 'BUILDING';
        try {
          const response = await handleFactoryApproval(service, { actor, authorization: null, method: 'POST', taskId: x.task.id, origin: 'https://mikka.example', url: `https://mikka.example/api/factory/tasks/${x.task.id}/approval`, body: { operation: 'approve', input: x.approval } });
          assert.equal(response.status, 202);
          assert.equal(provider.posts(), before + 1);
          const publication = (await service.ledger(actor, x.task.id)).publications[0];
          assert.equal((response.body as { publicationId?: string }).publicationId, publication.id);
          assert.equal(publication.status, 'reserved');
          for (const deployment of provider.deployments.values()) deployment.readyState = 'READY';
          assert.equal((await service.reconcile(actor, { ...publication.request, publicationId: publication.id })).publicationId, publication.id);
          assert.equal(provider.posts(), before + 1);
        } finally { provider.state.readyState = 'READY'; }
      });
      await t.test('approval accepts taskId and revision without redundant client context', async () => {
        const x = await f.prepare();
        const service = f.service([f.adapter]);
        const minimal = { taskId: x.approval.binding.taskId, revision: x.approval.binding.revision };
        const request: Record<string, unknown> = { ...x.approval, binding: minimal };
        delete request.expiresAt;
        const approval = await service.approve(actor, request);
        await pool.query('UPDATE factory_approvals SET request=jsonb_set(request,\'{binding}\',$2::jsonb) WHERE id=$1', [approval.approvalId, JSON.stringify({ ...minimal, issueId: randomUUID(), attemptId: randomUUID(), candidateId: randomUUID() })]);
        const replay = await service.approve(actor, { ...x.approval, binding: { ...minimal, issueId: randomUUID(), attemptId: randomUUID(), candidateId: randomUUID() } });
        assert.equal(replay.approvalId, approval.approvalId);
        const publication = { binding: { taskId: approval.binding.taskId, revision: approval.binding.revision }, eventId: randomUUID(), approvalId: approval.approvalId, action: x.approval.action, target: x.approval.target, targetEnvironment: x.approval.targetEnvironment };
        const published = await service.publish(actor, publication);
        assert.ok(published?.publicationId);
      });
      await t.test(
        "a live browser session approves and publishes without any decision authority",
        async () => {
          const x = await f.prepare(),
            human = { ...x.approval } as Record<string, unknown>,
            service = f.service([f.adapter]),
            before = provider.posts();

          delete human.evidenceDigest;
          delete human.evidenceReadId;
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM factory_evidence_reads",
              )
            ).rows[0].n,
            0,
          );
          // GET evidence remains available for display and never writes a receipt.
          await service.evidence(actor, x.task.id);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM factory_evidence_reads",
              )
            ).rows[0].n,
            0,
          );
          const approved = await service.approve(actor, human);
          // Display content can change without invalidating the approved commit.
          await pool.query(
            `UPDATE agent_runs SET report=jsonb_set(report,'{summary}','"updated display"') WHERE "issueId"=$1`,
            [x.task.issueId],
          );
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
          assert.equal(
            (
              await pool.query(
                'SELECT "evidenceDigest" FROM factory_approvals WHERE id=$1',
                [approved.approvalId],
              )
            ).rows[0].evidenceDigest,
            null,
          );
          assert.equal(grant.decisionCredentialId, null);
          assert.equal(grant.decisionScope, null);
          assert.equal(grant.decisionEvidence, null);
          const next = await f.prepare(),
            nextHuman = { ...next.approval } as Record<string, unknown>;

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
        "backend identity and a supplied decision credential cannot approve",
        async () => {
          const x = await f.prepare(),
            service = f.service();
          await rejects(
            () => service.approve({ userId: actor.userId }, x.approval),
            "factoryHumanRequired",
          );
          await rejects(
            () =>
              service.approve(actor, {
                ...x.approval,
                decisionCredentialId: "removed-path",
              }),
            "factoryInvalid",
          );
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
              1,
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
          ])
            await rejects(
              () => s.approve(actor, { ...x.approval, ...patch }),
              "factoryEvidenceMismatch",
            );
          await rejects(
            () => s.approve({ ...actor, userId: "foreign" }, x.approval),
            "factoryNotFound",
          );
          const historicalExpiry = await f.prepare();
          const alreadyExpiredInput = await s.approve(actor, { ...historicalExpiry.approval, expiresAt: new Date(Date.now() - 1000).toISOString() });
          assert.ok(alreadyExpiredInput.approvalId, 'approval is an action, not a renewable grant');
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
            const historical = await readFactoryPublicationReceiptV2(
              tx,
              actor.userId,
              x.task.id,
              x.task.candidateId!,
            );
            assert.equal(historical.publicationId, result.publicationId);
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
            f.approvalRequestForHuman({
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
            const historical = await readFactoryPublicationReceiptV2(
              tx,
              actor.userId,
              x.task.id,
              x.task.candidateId!,
            );
            assert.equal(historical.verifiedTarget.provider, undefined);
          } finally {
            tx.release();
          }
        },
      );
      await t.test(
        "publication read checks succeeded, cancellation, current candidate and revocation",
        async () => {
          const x = await f.prepare(),
            service = f.service();
          const request = await x.publication();
          const result = await service.publish(actor, request);
          assert.ok(result);
          const tx = await pool.connect();
          const read = () =>
            readFactoryPublicationReceiptV2(
              tx,
              actor.userId,
              x.task.id,
              x.task.candidateId!,
            );
          try {
            assert.equal((await read()).publicationId, result.publicationId);
            for (const status of ["cancelled", "revoked"]) {
              await pool.query(
                "UPDATE factory_tasks SET status=$2 WHERE id=$1",
                [x.task.id, status],
              );
              await rejects(read, "factoryPublicationReceiptRequired");
            }
            await pool.query(
              "UPDATE factory_tasks SET status='passed',\"candidateId\"=NULL WHERE id=$1",
              [x.task.id],
            );
            await rejects(read, "factoryPublicationReceiptRequired");
            await pool.query(
              'UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1',
              [x.task.id, x.task.candidateId],
            );
            await pool.query(
              'UPDATE factory_approvals SET "revokedAt"=now() WHERE id=$1',
              [request.approvalId],
            );
            await rejects(read, "factoryPublicationReceiptRequired");
            await rejects(() => service.publish(actor, request), 'factoryApprovalInvalid');
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
              window === 'queued' ? 'factoryPublicationPending' : 'factoryPublicationUncertain',
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
        "reserved approval ignores grant expiry; task STOP, sign-out, candidate and destination changes block effects",
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
            if (scenario === "revoked") {
              await rejects(() => s.revoke(actor, {
                binding: p.binding,
                approvalId: p.approvalId,
                eventId: randomUUID(),
              }), 'factoryPublicationAlreadyClaimed');
              await pool.query("UPDATE factory_tasks SET status='cancelled' WHERE id=$1", [x.task.id]);
            }
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
            if (scenario === 'expired') {
              assert.ok(await s.publish(actor, p));
              assert.equal(provider.posts(), before + 1);
            } else {
              await assert.rejects(() => s.publish(actor, { ...p, ...patch }));
              assert.equal(provider.posts(), before);
            }
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
        "grant expiry no longer interrupts an approved reservation; current session expiry still prevents POST",
        async () => {
          provider.state.projectDelayMs = 2500;
          try {
            for (const field of ["approval", "session"]) {
              const before = provider.posts();
              const x = await f.prepare();
              if (field === "approval")
                x.approval.expiresAt = new Date(
                  Date.now() + 2000,
                ).toISOString();
              Object.assign(x.approval, f.approvalRequestForHuman(x.approval));
              const p = await x.publication();
              if (field === "session")
                await pool.query(
                  'UPDATE "session" SET "expiresAt"=now()+interval \'2 seconds\' WHERE id=$1',
                  [actor.sessionId],
                );
              try {
                if (field === 'approval') {
                  assert.ok(await f.service().publish(actor, p));
                  assert.equal(provider.posts(), before + 1);
                } else {
                  await rejects(() => f.service().publish(actor, p), 'factoryHumanRequired');
                  assert.equal(provider.posts(), before);
                }
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
          // Expiry gates only new reservations: the recorded outcome still replays, with no POST.
          const before = provider.posts();
          assert.deepEqual(await s.publish(actor, p), r);
          assert.deepEqual(
            await s.reconcile(actor, { ...p, publicationId: r.publicationId }),
            r,
          );
          assert.equal(provider.posts(), before);
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
            await rejects(() => s.revoke(actor, {
              binding: r.binding,
              approvalId: p.approvalId,
              eventId: randomUUID(),
            }), 'factoryPublicationAlreadyClaimed');
            await pool.query("UPDATE factory_tasks SET status='revoked' WHERE id=$1", [x.task.id]);
            await rejects(() => s.publish(actor, p), "factoryStopped");
            await rejects(
              () =>
                s.reconcile(actor, { ...p, publicationId: r.publicationId }),
              "factoryStopped",
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
        },
      );
      await t.test(
        "pending publication: an expired grant and a signed-out approver still let another session record the provider result",
        async () => {
          const x = await f.prepare(),
            human = { ...x.approval } as Record<string, unknown>,
            s = f.service([f.adapter]);

          const approved = await s.approve(actor, human);
          const p = {
            ...approved,
            eventId: randomUUID(),
            action: x.approval.action,
            target: x.approval.target,
            targetEnvironment: x.approval.targetEnvironment,
          };
          provider.state.readyState = "BUILDING";
          const other = {
            userId: actor.userId,
            sessionId: `other-device-${randomUUID()}`,
          };
          try {
            await assert.rejects(
              () => s.publish(actor, p),
              (e: unknown) =>
                e instanceof PublicationDeferred && e.state === "pending",
            );
            const op = (await s.ledger(actor, x.task.id)).publications[0];
            assert.equal(op.status, "reserved");
            const posts = provider.posts();
            // More than the grant's lifetime later, from another device, approver signed out.
            await pool.query(
              "UPDATE factory_approvals SET \"expiresAt\"=now()-interval '1 minute' WHERE id=$1",
              [p.approvalId],
            );
            await pool.query(
              'UPDATE "session" SET "expiresAt"=now()-interval \'1 minute\' WHERE id=$1',
              [actor.sessionId],
            );
            await pool.query(
              `INSERT INTO "session" VALUES ($1,$2,now()+interval '1 hour')`,
              [other.sessionId, other.userId],
            );
            for (const d of provider.deployments.values())
              d.readyState = "READY";
            const result = await s.reconcile(other, {
              ...p,
              publicationId: op.id,
            });
            assert.equal(result.publicationId, op.id);
            assert.equal(provider.posts(), posts, "reconcile never POSTs");
            const ledger = await s.ledger(other, x.task.id);
            assert.equal(ledger.publications[0].status, "succeeded");
            assert.equal(ledger.binding.revision, result.binding.revision);
            const {
              rows: [task],
            } = await pool.query(
              "SELECT stage,status FROM factory_tasks WHERE id=$1",
              [x.task.id],
            );
            assert.deepEqual(task, { stage: "publish", status: "passed" });
            // A legacy second publish reads the approved operation; it cannot
            // reserve or execute another deployment.
            assert.equal((await s.publish(other, { ...p, eventId: randomUUID() }))?.publicationId, op.id);
            assert.equal(provider.posts(), posts);
          } finally {
            provider.state.readyState = "READY";
            await pool.query(
              'UPDATE "session" SET "expiresAt"=now()+interval \'1 hour\' WHERE id=$1',
              [actor.sessionId],
            );
          }
        },
      );
      await t.test(
        "pending publication: grant revoke is obsolete and task STOP blocks reconcile and every new publish",
        async () => {
          const x = await f.prepare(),
            p = await x.publication(),
            s = f.service();
          provider.state.readyState = "BUILDING";
          try {
            await assert.rejects(
              () => s.publish(actor, p),
              (e: unknown) => e instanceof PublicationDeferred,
            );
            const op = (await s.ledger(actor, x.task.id)).publications[0];
            await rejects(() => s.revoke(actor, {
              binding: p.binding,
              approvalId: p.approvalId,
              eventId: randomUUID(),
            }), 'factoryPublicationAlreadyClaimed');
            await pool.query("UPDATE factory_tasks SET status='cancelled' WHERE id=$1", [x.task.id]);
            for (const d of provider.deployments.values())
              d.readyState = "READY";
            const before = provider.posts(),
              requests = provider.requests.length;
            await rejects(
              () => s.reconcile(actor, { ...p, publicationId: op.id }),
              "factoryStopped",
            );
            assert.equal(
              provider.requests.length,
              requests,
              "provider not asked",
            );
            assert.equal(
              (await s.ledger(actor, x.task.id)).publications[0].status,
              "reserved",
            );
            await rejects(
              () => s.publish(actor, { ...p, eventId: randomUUID() }),
              "factoryStopped",
            );
            assert.equal(provider.posts(), before);
          } finally {
            provider.state.readyState = "READY";
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
