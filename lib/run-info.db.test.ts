import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runInfo } from "./run-info";
import { runInfoParts } from "./run-info-view";

/*
 * 运行信息 against real Postgres: the machine, Agent, model and payer come only
 * from what the run froze, a move adds where it went, and a teammate's run
 * shows nothing.
 */
const databaseURL = process.env.E2E_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && !databaseURL) throw new Error("Run info database test URL required");

test("run info: machine, model and payer from the frozen run; moves; nothing for others", { skip: !databaseURL }, async () => {
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(databaseURL!).hostname));
  assert.equal(new URL(databaseURL!).pathname, "/mikka_e2e");
  const admin = new Pool({ connectionString: databaseURL });
  const schema = `run_info_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL);
      CREATE TABLE agents (id uuid PRIMARY KEY, harness text NOT NULL);
      CREATE TABLE devices (id uuid PRIMARY KEY, name text, kind text);
      CREATE TABLE byos_connections (id uuid PRIMARY KEY, provider text, quota jsonb);
      CREATE TABLE byos_bindings (id uuid PRIMARY KEY, "ownerId" text, "connectionId" uuid);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text, "agentId" uuid, "deviceId" uuid, "agentDefinition" jsonb);
      CREATE TABLE coordinator_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" text, kind text, "runId" uuid, payload jsonb);
      INSERT INTO "user" VALUES ('alice','Alex'),('bob','林同学')`);
    const [agent, server, cloud, laptop, connection, binding] = Array.from({ length: 6 }, () => randomUUID());
    await pool.query(`INSERT INTO agents VALUES ($1,'claude_code')`, [agent]);
    await pool.query(`INSERT INTO devices VALUES ($1,'my-server','local'),($2,'cloud','cloud'),($3,'MacBook','local')`, [server, cloud, laptop]);
    await pool.query(`INSERT INTO byos_connections VALUES ($1,'claude',$2)`, [connection, JSON.stringify({ plan: "Max" })]);
    await pool.query(`INSERT INTO byos_bindings VALUES ($1,'alice',$2)`, [binding, connection]);
    const [pinned, plain, onCloud, moved, theirs, bare] = Array.from({ length: 6 }, () => randomUUID());
    const run = (id: string, user: string, device: string | null, definition: unknown) =>
      pool.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,$4,$5)`, [id, user, agent, device, definition === null ? null : JSON.stringify(definition)]);
    await run(pinned, "alice", server, { harness: "claude_code", subscription: { bindingId: binding, modelId: "claude-sonnet-fixture", route: "claude_code_cli" } });
    await run(plain, "alice", server, null);
    await run(onCloud, "alice", cloud, { harness: "codex", model: "gpt-fixture" });
    await run(moved, "alice", laptop, null);
    await run(theirs, "bob", server, null);
    await run(bare, "alice", null, null);
    await pool.query(`INSERT INTO coordinator_events ("userId",kind,"runId",payload) VALUES ('alice','run_retried',$1,$2)`, [moved, JSON.stringify({ retryRunId: randomUUID(), attempt: 2, maxAttempts: 3, movedToDeviceId: cloud })]);

    const infos = await runInfo(pool, "alice", [pinned, plain, onCloud, moved, theirs, bare]);
    const line = (id: string) => runInfoParts(infos.get(id)!, (owner, plan) => `${owner} 的 ${plan}`).join(" · ");
    assert.equal(line(pinned), "my-server · claude-sonnet-fixture · Alex 的 Claude Max");
    assert.equal(line(plain), "my-server · Claude Code", "no model or payer was frozen: none shown");
    assert.equal(line(onCloud), "E2B · gpt-fixture");
    assert.deepEqual(infos.get(moved)!.movedTo, { kind: "cloud" });
    assert.equal(line(bare), "Claude Code");
    assert.equal(infos.has(theirs), false, "a teammate's run shows nothing");
    assert.equal((await runInfo(pool, "alice", [])).size, 0);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
