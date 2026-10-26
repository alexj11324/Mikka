import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  compileFactoryBootstrap,
  readFactoryBootstrapSources,
  validateFactoryBootstrapTarget,
  bootstrapFactoryCreateOnly,
} from "./create-only-bootstrap.mjs";
const sources = await readFactoryBootstrapSources();
const schema = () => `factory_192_${randomUUID().replaceAll("-", "")}`;
const url = "postgres://fixture@127.0.0.1:55479/mikka_e2e";

test("pinned complete source set compiles without executing destructive SQL", () => {
  const plan = compileFactoryBootstrap(sources);
  assert.equal(plan.length, 67);
  assert.equal(plan[0].name, "20261023221259_application_baseline.sql");
  for (const step of plan)
    assert.doesNotMatch(
      step.sql.replace(/--[^\n]*/g, ""),
      /\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i,
    );
  // DELETE event/FK declarations remain intact; this is not keyword stripping.
  assert.match(
    plan.map((s) => s.sql).join("\n"),
    /BEFORE UPDATE OR DELETE ON agent_runs/,
  );
  assert.match(plan.map((s) => s.sql).join("\n"), /ON DELETE CASCADE/);
});
test("changed bytes, added, missing, duplicate and renamed migration fail closed", () => {
  for (const candidate of [
    sources.slice(1),
    [...sources, sources[0]],
    [...sources, { name: "future.sql", content: "SELECT 1;" }],
    sources.map((s, i) => (i === 0 ? { ...s, content: s.content + "\n" } : s)),
    sources.map((s, i) => (i === 0 ? { ...s, name: "unknown.sql" } : s)),
  ]) {
    assert.throws(
      () => compileFactoryBootstrap(candidate),
      /source set changed/,
    );
  }
});
test("obsolete definitions omitted with removals; final constraints and triggers retained", () => {
  const plan = new Map(
    compileFactoryBootstrap(sources).map((s) => [s.name, s.sql]),
  );
  assert.doesNotMatch(
    plan.get("20261023143000_decision_calls.sql"),
    /create table/i,
  );
  assert.doesNotMatch(
    plan.get("0004_linear_sync.sql"),
    /unique \("threadId", "messageId"\)/,
  );
  assert.match(
    plan.get("0005_linear_sync_retry_and_comment_keys.sql"),
    /linear_comment_links_local_key/,
  );
  assert.match(
    plan.get("0001_agents_devices.sql"),
    /create table if not exists run_messages \(\s+id uuid primary key,\s+"runId" uuid references/,
  );
  assert.doesNotMatch(
    plan.get("0006_workspace_tables.sql"),
    /"userId" text not null unique/,
  );
  assert.match(
    plan.get("20261025052033_group_review_mailboxes.sql"),
    /ADD CONSTRAINT session_mailboxes_kind_check CHECK \(kind IN \('run','coordinator','bot','group'\)\)/,
  );
  assert.match(
    plan.get("20261025052202_credential_handoff.sql"),
    /ADD CONSTRAINT credential_requests_state_check[\s\S]*handoff_required/,
  );
  assert.match(
    plan.get("20261025082237_group_turn_mailbox_policy.sql"),
    /conversation_work_round_identity/,
  );
  assert.doesNotMatch(
    plan.get("20261025170000_security_audit_application.sql"),
    /CREATE TRIGGER security_audit_immutable/,
  );
  assert.match(
    plan.get("20261025170001_security_audit_workspace.sql"),
    /CREATE TRIGGER security_audit_immutable/,
  );
  assert.match(
    plan.get("20261025170000_security_audit_application.sql"),
    /CREATE TRIGGER security_audit_transition/,
  );
});
test("target profile rejects foreign schema, remote target and unlisted DB/port/options", () => {
  assert.deepEqual(validateFactoryBootstrapTarget(url, schema()), {
    database: "mikka_e2e",
    user: "fixture",
  });
  for (const bad of [
    "postgres://remote:55479/mikka_e2e",
    "postgres://127.0.0.1:55479/production",
    "postgres://127.0.0.1:7777/mikka_e2e",
    url + "?options=unsafe",
  ])
    assert.throws(() => validateFactoryBootstrapTarget(bad, schema()));
  assert.throws(() => validateFactoryBootstrapTarget(url, "public"));
});
test("mismatched pool target rejects before any connection or DDL", async () => {
  let connections = 0;
  const pool = {
    options: { connectionString: "postgres://remote/mikka_e2e" },
    connect() {
      connections++;
      throw Error("unexpected");
    },
  };
  await assert.rejects(
    () =>
      bootstrapFactoryCreateOnly(pool, { databaseUrl: url, schema: schema() }),
    /checked target/,
  );
  assert.equal(connections, 0);
});
test("occupied schema, event trigger, missing extension or wrong identity stop before DDL", async () => {
  for (const change of [
    { occupied: true },
    { event_triggers: true },
    { trgm: false },
    { database: "production" },
    { username: "foreign" },
    { temp: "42" },
    { version: "160004" },
  ]) {
    const calls = [];
    let released = false;
    const pool = {
      options: { connectionString: url },
      connect: async () => ({
        query: async (sql) => {
          calls.push(sql);
          return {
            rows: [
              {
                database: "mikka_e2e",
                username: "fixture",
                version: "170005",
                temp: "0",
                occupied: false,
                event_triggers: false,
                trgm: true,
                ...change,
              },
            ],
          };
        },
        release(destroy) {
          assert.equal(destroy, true);
          released = true;
        },
      }),
    };
    await assert.rejects(() =>
      bootstrapFactoryCreateOnly(pool, { databaseUrl: url, schema: schema() }),
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^SELECT/);
    assert.equal(released, true);
  }
});
test("post-create failure retains namespace without cleanup SQL", async () => {
  const calls = [];
  let released = false;
  const pool = {
    options: { connectionString: url },
    connect: async () => ({
      query: async (sql) => {
        calls.push(sql);
        if (calls.length === 1)
          return {
            rows: [
              {
                database: "mikka_e2e",
                username: "fixture",
                version: "170005",
                temp: "0",
                occupied: false,
                event_triggers: false,
                trgm: true,
              },
            ],
          };
        if (calls.length === 2) return {};
        throw Error("synthetic connection failure");
      },
      release() {
        released = true;
      },
    }),
  };
  await assert.rejects(
    () =>
      bootstrapFactoryCreateOnly(pool, { databaseUrl: url, schema: schema() }),
    /synthetic connection/,
  );
  assert.match(calls[1], /^CREATE SCHEMA/);
  assert.equal(calls.length, 3);
  assert.equal(released, true);
  assert.ok(
    calls.every((sql) => !/^\s*(DROP|DELETE|TRUNCATE|ROLLBACK)/i.test(sql)),
  );
});

test("successful mock executes complete compiled plan through frozen search adapter only", async () => {
  const targetSchema = schema();
  const calls = [];
  let released = false;
  const pool = {
    options: { connectionString: url },
    connect: async () => ({
      query: async (sql) => {
        calls.push(sql);
        if (sql.startsWith("SELECT current_database()"))
          return {
            rows: [
              {
                database: "mikka_e2e",
                username: "fixture",
                version: "170005",
                temp: "0",
                occupied: false,
                event_triggers: false,
                trgm: true,
              },
            ],
          };
        if (sql === "SELECT current_schema() AS schema")
          return { rows: [{ schema: targetSchema }] };
        if (sql.startsWith("SELECT e.oid,n.nspname"))
          return { rows: [{ oid: 42, nspname: "public" }] };
        if (sql.startsWith("SELECT current_setting('search_path')"))
          return { rows: [{ path: targetSchema, oid: 100 }] };
        if (sql.startsWith("SELECT to_regclass('issues')"))
          return { rows: [{ oid: 100 }] };
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    }),
  };
  const result = await bootstrapFactoryCreateOnly(pool, {
    databaseUrl: url,
    schema: targetSchema,
  });
  assert.equal(result.migrations, 67);
  assert.equal(result.effectsComplete, false);
  assert.match(result.equivalence, /comparison pending/);
  assert.equal(released, true);
  const plan = compileFactoryBootstrap(sources);
  assert.ok(plan.every((step) => calls.includes(step.sql)));
  assert.equal(
    calls.filter((sql) => sql.startsWith("CREATE SCHEMA")).length,
    1,
  );
  for (const sql of calls)
    assert.doesNotMatch(
      sql.replace(/--[^\n]*/g, ""),
      /\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i,
    );
});
