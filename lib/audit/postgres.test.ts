import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import {
  appendAudit,
  createExport,
  exportPage,
  transaction,
  verifyAudit,
  pruneAudit,
  auditActor,
} from "./store";
import { auditHttp } from "./http";

const appURL = process.env.AUDIT_APP_TEST_URL;
const workspaceURL = process.env.AUDIT_WORKSPACE_TEST_URL;
function guarded(value: string | undefined) {
  if (!value) throw new Error("explicit isolated audit test URLs required");
  const url = new URL(value);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.pathname.endsWith("_e2e")
  )
    throw new Error("disposable loopback database required");
  return value;
}
test(
  "PostgreSQL audit: tenant isolation, role matrix, retries, immutable export, failure and retention",
  { skip: !appURL && process.env.REQUIRE_AUDIT_DB !== "1" },
  async (t) => {
    const app = new Pool({ connectionString: guarded(appURL) }),
      workspace = new Pool({ connectionString: guarded(workspaceURL) });
    assert.notEqual(appURL, workspaceURL, "real separate databases required");
    const tenant = randomUUID(),
      other = randomUUID(),
      owner = `audit_${randomUUID()}`,
      member = `audit_${randomUUID()}`;
    try {
      await app.query(
        readFileSync(
          "drizzle/20261025170000_security_audit_application.sql",
          "utf8",
        ),
      );
      await workspace.query(
        readFileSync(
          "drizzle/20261025170001_security_audit_workspace.sql",
          "utf8",
        ),
      );
      // Repeat migration and keep existing history intact.
      await app.query(
        readFileSync(
          "drizzle/20261025170000_security_audit_application.sql",
          "utf8",
        ),
      );
      await workspace.query(
        `INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'synthetic-audit'),($3,$2,'synthetic-other')`,
        [tenant, owner, other],
      );
      await transaction(workspace, async (tx) => {
        await tx.query("SELECT set_config('mikka.audit_actor',$1,true)", [
          owner,
        ]);
        await tx.query(
          `INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,'synthetic','audit@example.invalid','admin','active'),($1,$3,'synthetic','member@example.invalid','member','active')`,
          [tenant, owner, member],
        );
      });
      const event = {
        actorId: owner,
        actorType: "human" as const,
        resourceId: randomUUID(),
        action: "credential.revoked",
        outcome: "success" as const,
        reason: "revoked",
      };
      await t.test(
        "concurrent retry is one event; conflicting duplicate rejected; secret fields rejected",
        async () => {
          const id = randomUUID();
          await Promise.all(
            Array.from({ length: 12 }, () =>
              appendAudit(app, tenant, event, id),
            ),
          );
          assert.equal(
            (
              await app.query(
                "SELECT count(*) FROM security_audit_events WHERE tenant=$1",
                [tenant],
              )
            ).rows[0].count,
            "1",
          );
          await assert.rejects(
            appendAudit(app, tenant, { ...event, reason: "changed" }, id),
            /security_audit_id_conflict/,
          );
          await assert.rejects(
            appendAudit(app, tenant, {
              ...event,
              token: "sensitive_synthetic",
            } as never),
            /security_audit_invalid/,
          );
          await assert.rejects(
            appendAudit(app, tenant, {
              ...event,
              resourceId: "secret with spaces",
            }),
            /security_audit_invalid/,
          );
          await appendAudit(app, other, { ...event, reason: "other_tenant" });
        },
      );
      const http = auditHttp({
        origin: "http://127.0.0.1",
        app,
        workspace,
        authenticate: async (req) => ({
          userId: req.headers.get("x-fixture-actor") ?? owner,
        }),
      });
      const call = (
        params: string,
        actor = owner,
        method = "GET",
        body?: unknown,
        extra: Record<string, string> = {},
      ) =>
        http(
          new Request(`http://127.0.0.1/api/audit${params}`, {
            method,
            headers: {
              cookie: "synthetic=1",
              "x-fixture-actor": actor,
              origin: "http://127.0.0.1",
              ...(body ? { "content-type": "application/json" } : {}),
              ...extra,
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        );
      await t.test(
        "admin/member/suspended/foreign/bearer/current revocation matrix and filters",
        async () => {
          const result = await call(`?workspaceId=${tenant}`);
          assert.equal(result.status, 200);
          const json = await result.json();
          assert.equal(json.events.length, 1);
          assert.equal(json.events[0].event.reason, "revoked");
          assert.equal(
            (await call(`?workspaceId=${tenant}`, member)).status,
            403,
          );
          assert.equal((await call(`?workspaceId=${other}`)).status, 403);
          assert.equal(
            (
              await call(`?workspaceId=${tenant}`, owner, "GET", undefined, {
                authorization: "Bearer mkw_synthetic",
              })
            ).status,
            401,
          );
          await workspace.query(
            'UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',
            [tenant, owner],
          );
          assert.equal((await call(`?workspaceId=${tenant}`)).status, 403);
          await workspace.query(
            'UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2',
            [tenant, owner],
          );
          assert.equal(
            (
              await (
                await call(`?workspaceId=${tenant}&action=credential.revoked`)
              ).json()
            ).events.length,
            1,
          );
          assert.equal(
            (
              await (
                await call(`?workspaceId=${tenant}&outcome=uncertain`)
              ).json()
            ).events.length,
            0,
          );
          assert.equal(
            (
              await call(
                `?workspaceId=${tenant}`,
                owner,
                "POST",
                { operation: "verify" },
                { origin: "https://evil.invalid" },
              )
            ).status,
            403,
          );
        },
      );
      await t.test(
        "configured origin survives internal proxy URL without trusting foreign origins",
        async () => {
          const request = new Request(
            `http://localhost/api/audit?workspaceId=${tenant}`,
            {
              method: "POST",
              headers: {
                cookie: "synthetic=1",
                origin: "http://127.0.0.1",
                "content-type": "application/json",
              },
              body: JSON.stringify({ operation: "verify" }),
            },
          );
          assert.equal((await http(request)).status, 200);
          const bad = new Request(
            `http://localhost/api/audit?workspaceId=${tenant}`,
            {
              method: "POST",
              headers: {
                cookie: "synthetic=1",
                origin: "http://localhost",
                "content-type": "application/json",
              },
              body: JSON.stringify({ operation: "verify" }),
            },
          );
          assert.equal((await http(bad)).status, 403);
        },
      );
      await t.test(
        "paged snapshot resumes after new events and fresh connection; no gaps/count/hash mismatch",
        async () => {
          for (let i = 0; i < 7; i++)
            await appendAudit(app, tenant, { ...event, reason: `page_${i}` });
          const id = randomUUID();
          const first = await transaction(app, (tx) =>
            createExport(tx, tenant, owner, id),
          );
          const second = await transaction(app, (tx) =>
            createExport(tx, tenant, owner, id),
          );
          assert.equal(first.upper_seq, second.upper_seq);
          await appendAudit(app, tenant, {
            ...event,
            reason: "after_snapshot",
          });
          let after = first.lower_seq,
            count = 0,
            lastHash = first.start_hash;
          const fresh = new Pool({ connectionString: appURL });
          try {
            do {
              const page = await transaction(fresh, (tx) =>
                exportPage(tx, tenant, owner, id, after, 2),
              );
              for (const row of page.rows) {
                assert.equal(row.prev_hash, lastHash);
                lastHash = row.hash;
                count++;
              }
              if (!page.next) break;
              after = page.next;
            } while (count < Number(first.count));
          } finally {
            await fresh.end();
          }
          assert.equal(count, Number(first.count));
          assert.equal(lastHash, first.end_hash);
          await assert.rejects(
            transaction(app, (tx) => exportPage(tx, other, owner, id, "0", 2)),
            /auditExportUnavailable/,
          );
          await assert.rejects(
            transaction(app, (tx) =>
              exportPage(tx, tenant, member, id, "0", 2),
            ),
            /auditExportUnavailable/,
          );
        },
      );
      await t.test(
        "two-store export resumes partial creation without replacing application snapshot",
        async () => {
          const id = randomUUID();
          const request = () =>
            new Request(
              `http://127.0.0.1/api/audit/export?workspaceId=${tenant}`,
              {
                method: "POST",
                headers: {
                  cookie: "synthetic=1",
                  origin: "http://127.0.0.1",
                  "idempotency-key": id,
                },
              },
            );
          await workspace.query(
            "ALTER TABLE security_audit_exports RENAME TO security_audit_exports_unavailable",
          );
          let first;
          try {
            assert.equal((await http(request(), true)).status, 503);
            first = (
              await app.query(
                "SELECT * FROM security_audit_exports WHERE id=$1",
                [id],
              )
            ).rows[0];
            assert.ok(first);
          } finally {
            await workspace.query(
              "ALTER TABLE security_audit_exports_unavailable RENAME TO security_audit_exports",
            );
          }
          await appendAudit(app, tenant, {
            ...event,
            reason: "between_source_snapshots",
          });
          const resumed = await http(request(), true);
          assert.equal(resumed.status, 200);
          const body = await resumed.json();
          assert.equal(body.snapshots.application.upper_seq, first.upper_seq);
          assert.equal(
            (
              await app.query(
                "SELECT count(*) FROM security_audit_events WHERE tenant=$1 AND id=$2",
                [tenant, id],
              )
            ).rows[0].count,
            "1",
          );
          assert.notEqual(
            body.snapshots.application.storeId,
            body.snapshots.workspace.storeId,
          );
          assert.equal((await call("?workspaceId=")).status, 422);
        },
      );
      await t.test(
        "run, credential, account approval and uncertain operation transitions are atomic and contain references only",
        async () => {
          const device = randomUUID(),
            agent = randomUUID(),
            run = randomUUID(),
            credential = randomUUID(),
            action = randomUUID(),
            operation = randomUUID(),
            connection = randomUUID();
          await app.query(
            `INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,'audit-fixture')`,
            [device, owner],
          );
          await app.query(
            `INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,$3,'codex')`,
            [agent, owner, agent],
          );
          await transaction(app, async (tx) => {
            await tx.query(
              "SELECT set_config('mikka.audit_workspace',$1,true)",
              [tenant],
            );
            await tx.query(
              `INSERT INTO agent_runs(id,"userId","agentId","deviceId",prompt) VALUES($1,$2,$3,$4,'synthetic_private_prompt')`,
              [run, owner, agent, device],
            );
          });
          const requestId = randomUUID();
          await transaction(app, async (tx) => {
            await auditActor(
              tx,
              "synthetic_worker_reference",
              "worker",
              requestId,
            );
            await tx.query(
              "UPDATE agent_runs SET status='running' WHERE id=$1",
              [run],
            );
          });
          await app.query(
            `INSERT INTO credential_requests(id,owner_id,workspace_id,task_id,run_id,execution_session,auth_session_id,service_id,service_policy_hash,target_origin,mode,state,nonce_hash,vault_ref,retention,expires_at)
        VALUES($1,$2,$3,$4,$5,'synthetic-session','synthetic-auth-session','fixture','synthetic_policy','https://example.invalid','api_header','pending','synthetic_nonce',$6,'once',now()+interval '1 day')`,
            [credential, owner, tenant, randomUUID(), run, randomUUID()],
          );
          await app.query(
            "UPDATE credential_requests SET state='cancelled' WHERE id=$1",
            [credential],
          );
          await app.query(
            `INSERT INTO pending_actions(id,"userId",action,input,status) VALUES($1,$2,'create_calendar_event','{"private":"synthetic_private_payload"}','pending')`,
            [action, owner],
          );
          await app.query(
            "UPDATE pending_actions SET status='declined' WHERE id=$1",
            [action],
          );
          await app.query(
            `INSERT INTO operation_ledger("operationId","ownerId","workspaceId",binding,"idempotencyKey") VALUES($1::uuid,$2,$3,'{"private":"synthetic_private_binding"}',$1::text)`,
            [operation, owner, tenant],
          );
          await app.query(
            'UPDATE operation_ledger SET status=\'uncertain\',"attemptToken"=$2 WHERE "operationId"=$1',
            [operation, randomUUID()],
          );
          await app.query(
            `INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state) VALUES($1,$2,$3,'claude','pending')`,
            [connection, owner, tenant],
          );
          await app.query(
            "UPDATE byos_connections SET state='disconnected' WHERE id=$1",
            [connection],
          );
          const events = (
            await app.query(
              "SELECT event FROM security_audit_events WHERE tenant=$1",
              [tenant],
            )
          ).rows.map((r) => r.event);
          assert.ok(
            events.some(
              (e) =>
                e.action === "agent_runs.update" &&
                e.actorId === "synthetic_worker_reference" &&
                e.requestId === requestId &&
                e.runId === run,
            ),
          );
          assert.ok(
            events.some(
              (e) => e.resourceId === credential && e.reason === "cancelled",
            ),
          );
          assert.ok(
            events.some(
              (e) => e.operationId === operation && e.outcome === "uncertain",
            ),
          );
          assert.ok(
            events.some(
              (e) => e.resourceId === connection && e.reason === "disconnected",
            ),
          );
          assert.ok(
            (
              await app.query(
                "SELECT 1 FROM security_audit_events WHERE tenant=$1 AND event->>'resourceId'=$2 AND event->>'reason'='declined'",
                [`personal:${owner}`, action],
              )
            ).rowCount,
          );
          assert.doesNotMatch(
            JSON.stringify(events),
            /synthetic_private_prompt|synthetic_private_payload|synthetic_private_binding|synthetic_nonce|target_origin/,
          );
          // Captured workspace survives retry creation even though the mailbox is personal/absent.
          const retry = randomUUID();
          await app.query(
            'INSERT INTO agent_runs(id,"userId","agentId","retryOf") VALUES($1,$2,$3,$4)',
            [retry, owner, agent, run],
          );
          assert.equal(
            (
              await app.query(
                "SELECT tenant FROM security_audit_resource_scopes WHERE source='agent_runs' AND resource=$1",
                [retry],
              )
            ).rows[0].tenant,
            tenant,
          );
          await transaction(app, (tx) => verifyAudit(tx, tenant));
        },
      );
      await t.test(
        "automatic auth lifecycle is durable, sanitised, and rolls back when audit cannot persist",
        async () => {
          const user = `audit_${randomUUID()}`;
          await app.query(
            `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'synthetic',$2,true,now(),now())`,
            [user, `${user}@example.invalid`],
          );
          await app.query(
            `INSERT INTO session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval '1 day',now(),now())`,
            [
              randomUUID(),
              user,
              `synthetic-never-export-token-${randomUUID()}`,
            ],
          );
          const events = (
            await app.query(
              "SELECT event::text FROM security_audit_events WHERE tenant=$1",
              [`personal:${user}`],
            )
          ).rows;
          assert.match(events[0].event, /auth.login/);
          assert.doesNotMatch(
            events[0].event,
            /synthetic-never-export-token|example.invalid/,
          );
          await transaction(app, async (tx) => {
            await tx.query(
              "ALTER TABLE security_audit_heads RENAME TO security_audit_heads_unavailable",
            );
            await tx.query("SAVEPOINT failure");
            await assert.rejects(
              tx.query(
                `INSERT INTO session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,'synthetic-failure',now()+interval '1 day',now(),now())`,
                [randomUUID(), user],
              ),
            );
            await tx.query("ROLLBACK TO SAVEPOINT failure");
            await tx.query(
              "ALTER TABLE security_audit_heads_unavailable RENAME TO security_audit_heads",
            );
          });
          assert.equal(
            (
              await app.query(
                "SELECT count(*) FROM session WHERE token='synthetic-failure'",
              )
            ).rows[0].count,
            "0",
          );
        },
      );
      await t.test(
        "unauthorised mutation blocked and controlled privileged corruption/deletion/reorder detected",
        async () => {
          await assert.rejects(
            app.query(
              "UPDATE security_audit_events SET hash='bad' WHERE tenant=$1",
              [tenant],
            ),
            /security_audit_immutable/,
          );
          await assert.rejects(
            app.query("DELETE FROM security_audit_events WHERE tenant=$1", [
              tenant,
            ]),
            /security_audit_immutable/,
          );
          for (const corruption of [
            "UPDATE security_audit_events SET hash='bad' WHERE tenant=$1 AND seq=1",
            "DELETE FROM security_audit_events WHERE tenant=$1 AND seq=1",
            "UPDATE security_audit_events SET seq=99999 WHERE tenant=$1 AND seq=1",
          ]) {
            await assert.rejects(
              transaction(app, async (tx) => {
                await tx.query(
                  "ALTER TABLE security_audit_events DISABLE TRIGGER security_audit_immutable",
                );
                await tx.query(corruption, [tenant]);
                await verifyAudit(tx, tenant);
              }),
              /auditIntegrityViolation/,
            );
          }
          await transaction(app, (tx) => verifyAudit(tx, tenant));
        },
      );
      await t.test(
        "legal hold, export lease, checkpoint prune and tombstone replay after expiry",
        async () => {
          const aged = randomUUID(),
            id = randomUUID();
          await appendAudit(app, aged, event, id);
          // Test-only age injection requires owner override; never expose this in an API.
          await transaction(app, async (tx) => {
            await tx.query(
              "ALTER TABLE security_audit_events DISABLE TRIGGER security_audit_immutable",
            );
            await tx.query(
              `UPDATE security_audit_events SET occurred_at=now()-interval '100 days', canonical=jsonb_set(canonical::jsonb,'{occurredAt}',to_jsonb(to_char((now()-interval '100 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))::text WHERE tenant=$1`,
              [aged],
            );
            await tx.query(
              "UPDATE security_audit_events SET hash=encode(sha256(convert_to(prev_hash||E'\\n'||canonical,'UTF8')),'hex') WHERE tenant=$1",
              [aged],
            );
            await tx.query(
              "UPDATE security_audit_heads SET hash=(SELECT hash FROM security_audit_events WHERE tenant=$1) WHERE tenant=$1",
              [aged],
            );
            await tx.query(
              "ALTER TABLE security_audit_events ENABLE TRIGGER security_audit_immutable",
            );
            await tx.query(
              "UPDATE security_audit_heads SET legal_hold=true WHERE tenant=$1",
              [aged],
            );
          });
          await assert.rejects(
            transaction(app, (tx) => pruneAudit(tx, aged, owner)),
            /auditLegalHold/,
          );
          await app.query(
            "UPDATE security_audit_heads SET legal_hold=false WHERE tenant=$1",
            [aged],
          );
          const snapshot = await transaction(app, (tx) =>
            createExport(tx, aged, owner, randomUUID()),
          );
          assert.equal(
            (await transaction(app, (tx) => pruneAudit(tx, aged, owner)))
              .removed,
            0,
          );
          await app.query(
            "UPDATE security_audit_exports SET expires_at=now()-interval '1 second' WHERE id=$1",
            [snapshot.id],
          );
          assert.equal(
            (await transaction(app, (tx) => pruneAudit(tx, aged, "system")))
              .removed,
            "1",
          );
          assert.equal(
            (
              await app.query(
                "SELECT event->>'actorType' AS type FROM security_audit_events WHERE tenant=$1 AND event->>'action'='audit.prune'",
                [aged],
              )
            ).rows[0].type,
            "system",
          );
          await appendAudit(app, aged, event, id);
          assert.equal(
            (
              await app.query(
                "SELECT count(*) FROM security_audit_events WHERE tenant=$1 AND id=$2",
                [aged, id],
              )
            ).rows[0].count,
            "0",
          );
          await transaction(app, (tx) => verifyAudit(tx, aged));
        },
      );
      console.log(
        JSON.stringify({
          evidence: "audit-210",
          tenants: [tenant, other],
          owner,
          member,
          appDatabase: new URL(appURL!).pathname.slice(1),
          workspaceDatabase: new URL(workspaceURL!).pathname.slice(1),
          kind: "fixture-context",
          utc: new Date().toISOString(),
        }),
      );
    } finally {
      await Promise.all([app.end(), workspace.end()]);
    }
  },
);
