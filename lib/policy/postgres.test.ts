import { MockLanguageModelV4 } from "ai/test";
import { APICallError } from "ai";
import { generatePolicyText } from "./generate-text";
import { drizzle } from "drizzle-orm/node-postgres";
import { policySqlClient } from "./sql-client";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Pool } from "pg";
import { transaction, verifyAudit } from "../audit/store";
import { PolicyStore } from "./store";
import { policySigner } from "./signing";
import { AGENT_ROUTE, authorizeModelRequest } from "./model";
import { PolicyError, type PolicyDocument } from "./contract";
const target = process.env.POLICY_WORKSPACE_TEST_URL;
const guarded = () => {
  const url = new URL(target ?? "");
  assert.ok(
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.pathname.endsWith("_e2e"),
    "explicit disposable loopback PostgreSQL required",
  );
  return url.toString();
};
test(
  "real PostgreSQL core policy transactions, tenant isolation, revocation and failure",
  { skip: !target && process.env.REQUIRE_POLICY_DB !== "1" },
  async (t) => {
    const pool = new Pool({ connectionString: guarded(), max: 16 });
    const store = new PolicyStore(
      pool,
      policySigner("isolated-only-secret-00000000000000000"),
    );
    const workspaceId = randomUUID(),
      other = randomUUID(),
      userId = `policy_${randomUUID()}`,
      member = `member_${randomUUID()}`;
    const document = (id = workspaceId): PolicyDocument => ({
      schemaVersion: 1,
      state: "enforce",
      offlineTtlSeconds: 60,
      layers: [
        {
          scope: "workspace",
          id,
          ceiling: { git_push: "deny" },
          models: [AGENT_ROUTE],
        },
      ],
    });
    try {
      const migration = readFileSync(
        "drizzle/20261026002528_organization_policy.sql",
        "utf8",
      );
      await pool.query(migration);
      await pool.query(migration);
      await pool.query(
        `INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'synthetic-policy'),($3,$2,'synthetic-other')`,
        [workspaceId, userId, other],
      );
      await pool.query(
        `INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,'Synthetic','policy@example.invalid','admin'),($3,$2,'Synthetic','policy@example.invalid','admin'),($1,$4,'Synthetic','member@example.invalid','member')`,
        [workspaceId, userId, other, member],
      );
      await t.test("no policy is explicitly unmanaged; member publication refused", async () => {
        assert.equal((await store.current(userId)).length,0);
        await assert.rejects(store.publish(workspaceId,member,0,document()), /policyAccessDenied/);
      });
      await t.test(
        "twelve concurrent publishers produce one winner, one version and one audit event",
        async () => {
          const replies = await Promise.allSettled(
            Array.from({length:12},()=>store.publish(workspaceId,userId,0,document())),
          );
          assert.equal(replies.filter(r=>r.status==='fulfilled').length,1);
          const rejected=replies.filter(r=>r.status==='rejected');
          assert.equal(rejected.length,11);
          for (const result of rejected) {
            assert.ok(result.reason instanceof PolicyError);
            assert.equal(result.reason.code,'policyVersionConflict');
            assert.equal(result.reason.status,409);
          }
          assert.equal(
            (
              await pool.query(
                "SELECT count(*) FROM organization_policy_versions WHERE workspace_id=$1",
                [workspaceId],
              )
            ).rows[0].count,
            "1",
          );
          assert.equal(
            (
              await pool.query(
                `SELECT count(*) FROM security_audit_events WHERE tenant=$1 AND event->>'action'='policy.published'`,
                [workspaceId],
              )
            ).rows[0].count,
            "1",
          );
          assert.ok(await store.read(workspaceId,userId));
          await assert.rejects(
            authorizeModelRequest(store, userId, AGENT_ROUTE),
            /policyBudgetUnavailable/,
          );
        },
      );
      await t.test(
        "tenant rules differ; route aliases, endpoints, region and unmanaged-scope omission cannot bypass",
        async () => {
          const denied = document(other);
          denied.layers[0].models = [];
          await store.publish(other, userId, 0, denied);
          assert.equal(
            (await store.checkModel(userId, AGENT_ROUTE, workspaceId)).length,
            1,
          );
          await assert.rejects(
            store.checkModel(userId, AGENT_ROUTE, other),
            /modelRouteDenied/,
          );
          await assert.rejects(
            store.checkModel(userId, AGENT_ROUTE),
            /modelRouteDenied/,
          );
          for (const route of [
            { ...AGENT_ROUTE, model: "alias" },
            { ...AGENT_ROUTE, region: "eu" as const },
            { ...AGENT_ROUTE, endpoint: "https://proxy.example/v1" },
          ])
            await assert.rejects(
              store.checkModel(userId, route, workspaceId),
              /modelRouteDenied/,
            );
          await assert.rejects(
            authorizeModelRequest(store, userId, AGENT_ROUTE),
            /modelRouteDenied/,
          );
          await assert.rejects(
            store.denyWorker(userId, randomUUID(), undefined, workspaceId),
            /workerEnforcementUnavailable/,
          );
          await assert.rejects(
            store.denyTool(userId, workspaceId),
            /toolEnforcementUnavailable/,
          );
          await assert.rejects(
            store.publish(workspaceId, userId, 1, {
              ...document(),
              layers: [
                ...document().layers,
                { scope: "team", id: randomUUID() },
              ],
            }),
            /policyScopeMismatch/,
          );
        },
      );
      await t.test(
        "revoke then rollback creates monotonic version, new instances see it and old signed bytes cannot supersede head",
        async () => {
          const old = await store.read(workspaceId, userId);
          await store.publish(workspaceId, userId, 1, {
            ...document(),
            state: "revoked",
          });
          await assert.rejects(
            store.current(userId, workspaceId),
            /policyRevoked/,
          );
          await assert.rejects(
            authorizeModelRequest(store, userId, AGENT_ROUTE),
            /policyRevoked/,
          );
          await assert.rejects(
            store.denyWorker(userId, randomUUID(), undefined, workspaceId),
            /policyRevoked/,
          );
          await assert.rejects(
            store.denyTool(userId, workspaceId),
            /policyRevoked/,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*) FROM security_audit_events WHERE tenant=$1 AND event->>'reason'='policyRevoked'",
                [workspaceId],
              )
            ).rows[0].count,
            "3",
          );
          const restored = await store.publish(
            workspaceId,
            userId,
            2,
            undefined,
            1,
          );
          assert.equal(restored.payload.version, 3);
          assert.equal(restored.payload.hash, old?.payload.hash);
          const restarted = new PolicyStore(pool, store.signer);
          assert.equal(
            (await restarted.current(userId, workspaceId))[0].signed.payload
              .version,
            3,
          );
          await assert.rejects(
            store.publish(workspaceId, userId, 1, document()),
            /policyVersionConflict/,
          );
          await assert.rejects(
            pool.query(
              "UPDATE organization_policy_versions SET actor_id=$2 WHERE workspace_id=$1",
              [workspaceId, "changed"],
            ),
            /immutable/,
          );
        },
      );
      await t.test(
        "audit failure rolls back publication; suspended users lose current reads and writes",
        async () => {
          await pool.query(
            `CREATE FUNCTION policy_test_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event->>'action'='policy.published' THEN RAISE EXCEPTION 'synthetic audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER policy_test_audit_fail BEFORE INSERT ON security_audit_events FOR EACH ROW EXECUTE FUNCTION policy_test_audit_fail()`,
          );
          try {
            await assert.rejects(store.publish(workspaceId,userId,3,document()), /synthetic audit unavailable/);
            assert.equal(
              (await store.read(workspaceId, userId))?.payload.version,
              3,
            );
          } finally {
            await pool.query(
              "DROP TRIGGER policy_test_audit_fail ON security_audit_events; DROP FUNCTION policy_test_audit_fail()",
            );
          }
          await pool.query(
            `UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`,
            [workspaceId, member],
          );
          await assert.rejects(
            store.read(workspaceId, member),
            /policyAccessDenied/,
          );
          await assert.rejects(store.publish(workspaceId,member,3,document()), /policyAccessDenied/);
          const verified = await transaction(pool, (tx) =>
            verifyAudit(tx, workspaceId),
          );
          assert.ok(verified);
        },
      );
      await t.test(
        "missing current version and replayed signed payload cannot become unmanaged or current",
        async () => {
          await pool.query(
            "UPDATE organization_policy_heads SET version=99 WHERE workspace_id=$1",
            [workspaceId],
          );
          try {
            await assert.rejects(
              store.current(userId, workspaceId),
              /policyVersionUnavailable/,
            );
            await assert.rejects(
              store.read(workspaceId, userId),
              /policyVersionUnavailable/,
            );
          } finally {
            await pool.query(
              "UPDATE organization_policy_heads SET version=3 WHERE workspace_id=$1",
              [workspaceId],
            );
          }
          const old = await store.read(workspaceId, userId, 1);
          await pool.query(
            "INSERT INTO organization_policy_versions(workspace_id,version,signed,actor_id) VALUES($1,99,$2,$3)",
            [workspaceId, old, userId],
          );
          await pool.query(
            "UPDATE organization_policy_heads SET version=99 WHERE workspace_id=$1",
            [workspaceId],
          );
          try {
            await assert.rejects(
              store.current(userId, workspaceId),
              /policyScopeMismatch/,
            );
          } finally {
            await pool.query(
              "UPDATE organization_policy_heads SET version=3 WHERE workspace_id=$1",
              [workspaceId],
            );
          }
        },
      );
      await t.test(
        "policy decisions reuse one held transaction connection and commit denial audit",
        { timeout: 5000 },
        async () => {
          const one = new Pool({
            connectionString: guarded(),
            max: 1,
            connectionTimeoutMillis: 500,
          });
          try {
            const scoped = new PolicyStore(one, store.signer),
              resource = randomUUID();
            const denied = await drizzle(one).transaction((tx) =>
              scoped.workerDenial(
                policySqlClient((statement) => tx.execute(statement)),
                userId,
                resource,
                undefined,
                workspaceId,
              ),
            );
            assert.equal(denied?.code, "workerEnforcementUnavailable");
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*) FROM security_audit_events WHERE tenant=$1 AND event->>'resourceId'=$2",
                  [workspaceId, resource],
                )
              ).rows[0].count,
              "1",
            );
          } finally {
            await one.end();
          }
        },
      );
      await t.test(
        "tool admission fences publication and denies without invoking side effects",
        async () => {
          const id = randomUUID(),
            actor = `tool_${randomUUID()}`;
          await pool.query(
            `INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Synthetic tool fence')`,
            [id, actor],
          );
          await pool.query(
            `INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,'Synthetic','tool@example.invalid','admin')`,
            [id, actor],
          );
          let entered!: () => void,
            finish!: () => void,
            sends = 0;
          const admitted = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const released = new Promise<void>((resolve) => {
            finish = resolve;
          });
          const running = store.withTool(actor, async () => {
            entered();
            await released;
            sends++;
            return "ok";
          }, [id]);
          await admitted;
          let published = false;
          const publication = store
            .publish(id, actor, 0, document(id))
            .then((value) => {
              published = true;
              return value;
            });
          // Observe the blocked exclusive policy lock in PG, not a timer guess.
          try {
            const deadline = Date.now() + 3000;
            while (
              !(
                await pool.query(
                  `SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted`,
                )
              ).rowCount
            ) {
              assert.ok(
                Date.now() < deadline,
                "publication must wait for admitted tool",
              );
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.equal(published, false);
          } finally {
            finish();
          }
          assert.equal(await running, "ok");
          await publication;
          await assert.rejects(
            store.withTool(actor, async () => {
              sends++;
            }, [id]),
            /toolEnforcementUnavailable/,
          );
          assert.equal(sends, 1);
          await store.publish(id, actor, 1, {
            ...document(id),
            state: "revoked",
          });
          await assert.rejects(
            store.withTool(actor, async () => {
              sends++;
            }, [id]),
            /policyRevoked/,
          );
          await pool.query(
            `UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`,
            [id, actor],
          );
          await assert.rejects(
            store.withTool(actor, async () => {
              sends++;
            }, [id]),
            /policyAccessDenied/,
          );
          assert.equal(sends, 1);
        },
      );
      await t.test(
        "real policy publication, revoke and revision during retryable SDK failure prevent a second send",
        async () => {
          for (const change of ["publish", "revoke", "revision"]) {
            const id = randomUUID(),
              actor = `retry_${randomUUID()}`;
            await pool.query(
              `INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Synthetic retry')`,
              [id, actor],
            );
            await pool.query(
              `INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,'Synthetic','retry@example.invalid','admin')`,
              [id, actor],
            );
            let sends = 0,
              gates = 0;
            const model = new MockLanguageModelV4({
              doGenerate: async () => {
                sends++;
                await store.publish(id, actor, 0, {
                  ...document(id),
                  state: change === "revoke" ? "revoked" : "enforce",
                });
                if (change === "revision")
                  await store.publish(id, actor, 1, document(id));
                throw new APICallError({
                  message: "Synthetic 503 after real policy change",
                  url: "https://fixture.invalid",
                  requestBodyValues: {},
                  statusCode: 503,
                  isRetryable: true,
                });
              },
            });
            const gate = async () => {
              gates++;
              await authorizeModelRequest(store, actor, AGENT_ROUTE);
            };
            await assert.rejects(
              generatePolicyText(gate, {
                model,
                prompt: "synthetic",
                maxRetries: 9,
              }),
              /Synthetic 503/,
            );
            assert.equal(sends, 1);
            await assert.rejects(
              generatePolicyText(gate, { model, prompt: "synthetic" }),
              change === "revoke" ? /policyRevoked/ : /policyBudgetUnavailable/,
            );
            assert.equal(sends, 1);
            assert.equal(gates, 2);
          }
        },
      );
      await t.test(
        "database unavailable rejects with no implicit unmanaged fallback",
        async () => {
          const unavailable = new Pool({
            connectionString:
              "postgresql://postgres@127.0.0.1:1/policy_workspace_e2e",
            connectionTimeoutMillis: 200,
          });
          try {
            const unavailableStore=new PolicyStore(unavailable,store.signer);
            await assert.rejects(unavailableStore.read(workspaceId,userId));
            await assert.rejects(unavailableStore.current(userId,workspaceId));
          } finally {
            await unavailable.end();
          }
        },
      );
    } finally {
      await pool.end();
    }
  },
);
