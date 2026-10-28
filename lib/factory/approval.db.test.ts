import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { factory194Fixture } from "../../tests/helpers/factory194";
import { FactoryError } from "./approval-contract";
import { handleFactoryApproval } from "./approval-http";
import { PublicationDeferred } from "./publication-operation";
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
  const u = new URL(db);
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.pathname, ci ? "/mikka_e2e" : "/factory194_test");
  assert.equal(u.port, ci ? "5432" : "55594");
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
      await t.test(
        "exact approval read, owner, SHA/scope/environment/digest/expiry and concurrent replay",
        async () => {
          const x = await f.prepare(),
            s = f.service();
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
                `CREATE FUNCTION reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected rollback'; END $$; CREATE TRIGGER reject_event BEFORE INSERT ON factory_events FOR EACH ROW EXECUTE FUNCTION reject_event()`,
              );
            try {
              await assert.rejects(
                () => f.service().publish(actor, p),
                window === "sql-rollback"
                  ? /injected rollback/
                  : (e: unknown) => e instanceof PublicationDeferred,
              );
            } finally {
              if (window === "sql-rollback")
                await pool.query(
                  "DROP TRIGGER reject_event ON factory_events; DROP FUNCTION reject_event()",
                );
            }
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
