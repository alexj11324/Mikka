import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { ExecutionSettings } from "./execution-settings";
const databaseURL = process.env.E2E_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && !databaseURL)
  throw new Error("Execution settings database test URL required");
test(
  "execution settings: migration replay, CRUD, ordering, owner and workspace boundaries",
  { skip: !databaseURL },
  async () => {
    assert.ok(
      ["127.0.0.1", "localhost"].includes(new URL(databaseURL!).hostname),
    );
    assert.equal(new URL(databaseURL!).pathname, "/mikka_e2e");
    const admin = new Pool({ connectionString: databaseURL });
    const schema = `execution_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: databaseURL,
      options: `-c search_path=${schema}`,
    });
    try {
      await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES ('alice'),('bob');
      CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,kind text,"lastSeenAt" timestamptz,enabled boolean,name text,harnesses jsonb,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid);
      CREATE TABLE byos_connections (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,epoch bigint,state text,provider text);
      CREATE TABLE byos_bindings (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,"consumerId" text,"connectionId" uuid,"connectionRevision" bigint,"modelId" text,route text,"createdAt" timestamptz DEFAULT now())`);
      const migration = await readFile(
        new URL(
          "../drizzle/20261030194605_execution_rules.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(migration);
      const settings = new ExecutionSettings(pool),
        alice = { ownerId: "alice", workspaceId: randomUUID() },
        bob = { ...alice, ownerId: "bob" },
        other = { ...alice, workspaceId: randomUUID() };
      const own = randomUUID(),
        foreign = randomUUID(),
        bot = randomUUID(),
        binding = randomUUID(),
        connection = randomUUID();
      await pool.query(
        `INSERT INTO devices (id,"ownerId",kind,enabled,harnesses) VALUES ($1,'alice','local',true,'[]'),($2,'bob','local',true,'[]')`,
        [own, foreign],
      );
      const value = {
        label: "backend",
        place: own,
        harness: "codex" as const,
        model: "auto",
      };
      assert.deepEqual(
        (await settings.list(alice)).map((r) => r.id),
        ["default"],
      );
      await settings.mutate(alice, { kind: "save", value });
      await settings.mutate(alice, {
        kind: "save",
        value: { ...value, label: "frontend", place: "cloud" },
      });
      const rules = await settings.list(alice),
        ids = rules.filter((r) => r.label !== null).map((r) => r.id);
      assert.equal((await settings.list(bob)).length, 1);
      assert.equal((await settings.list(other)).length, 1);
      await assert.rejects(
        settings.mutate(alice, {
          kind: "save",
          value: { ...value, place: foreign },
        }),
      );
      await assert.rejects(
        settings.mutate(bob, { kind: "save", id: ids[0], value }),
      );
      await assert.rejects(
        settings.mutate(other, { kind: "delete", id: ids[0] }),
      );
      await assert.rejects(
        settings.mutate(alice, { kind: "delete", id: "default" }),
      );
      await assert.rejects(
        settings.mutate(alice, { kind: "reorder", ids: [ids[0], ids[0]] }),
      );
      await settings.mutate(alice, {
        kind: "reorder",
        ids: [...ids].reverse(),
      });
      assert.deepEqual(
        (await settings.list(alice)).slice(0, 2).map((r) => r.id),
        [...ids].reverse(),
      );
      await settings.mutate(alice, {
        kind: "save",
        id: ids[0],
        value: { ...value, model: "explicit-model" },
      });
      assert.equal(
        (await settings.list(alice)).find((r) => r.id === ids[0])?.model,
        "explicit-model",
      );
      await settings.mutate(alice, { kind: "delete", id: ids[1] });
      assert.equal((await settings.list(alice))[0].position, 0);
      await assert.rejects(settings.redetect(bob, own));
      await settings.redetect(alice, own);
      assert.ok(
        (
          await pool.query(
            'SELECT "redetectRequestedAt" FROM devices WHERE id=$1',
            [own],
          )
        ).rows[0].redetectRequestedAt,
      );
      await pool.query("INSERT INTO bots VALUES ($1,$2,$3)", [
        bot,
        alice.ownerId,
        alice.workspaceId,
      ]);
      await pool.query(
        `INSERT INTO byos_connections VALUES ($1,'alice',$2,1,'connected','codex');`,
        [connection, alice.workspaceId],
      );
      await pool.query(
        `INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision","modelId",route) VALUES ($1,'alice',$2,$3,$4,1,'dynamic-model','codex_cpa')`,
        [binding, alice.workspaceId, bot, connection],
      );
      assert.equal(
        (await settings.botModels(alice))[0].modelId,
        "dynamic-model",
      );
      assert.equal((await settings.botModels(bob)).length, 0);
      await assert.rejects(settings.setBotModel(bob, bot, binding));
      await assert.rejects(settings.setBotModel(other, bot, binding));
      await settings.setBotModel(alice, bot, binding);
      assert.equal(await settings.botModel(alice, bot), binding);
      await settings.setBotModel(alice, bot, null);
      assert.equal(await settings.botModel(alice, bot), undefined);
      await settings.setBotModel(alice, null, binding);
      assert.equal(await settings.botModel(alice, null), binding);
      const secondBot = randomUUID();
      await pool.query("INSERT INTO bots VALUES ($1,$2,$3)", [
        secondBot,
        alice.ownerId,
        alice.workspaceId,
      ]);
      await settings.setBotModel(alice, secondBot, binding);
      const copiedBinding = await settings.botModel(alice, secondBot);
      assert.notEqual(copiedBinding, binding);
      assert.equal(
        (
          await pool.query(
            'SELECT "consumerId" FROM byos_bindings WHERE id=$1',
            [copiedBinding],
          )
        ).rows[0].consumerId,
        secondBot,
      );
      let sessionOwner: string | null = "alice";
      const stub = (path: string, exports: Record<string, unknown>) =>
        mock.module(new URL(path, import.meta.url).href, {
          namedExports: exports,
        });
      mock.module("next/headers", {
        namedExports: { headers: async () => new Headers() },
      });
      stub("./auth.ts", {
        auth: {
          api: {
            getSession: async () =>
              sessionOwner ? { user: { id: sessionOwner } } : null,
          },
        },
      });
      stub("./workspace-access.ts", {
        loadWorkspaceContext: async () => ({
          workspace: { id: alice.workspaceId },
        }),
      });
      stub("./db/index.ts", { pool });
      const actions = await import("../app/actions/execution-settings");
      sessionOwner = null;
      await assert.rejects(actions.listExecutionRules());
      sessionOwner = "bob";
      await assert.rejects(actions.deleteExecutionRule(ids[0]));
      await assert.rejects(actions.redetectDevice(own));
      sessionOwner = "alice";
      await actions.createExecutionRule({ ...value, label: "actions" });
      assert.ok(
        (await actions.listExecutionRules()).some(
          (rule) => rule.label === "actions",
        ),
      );
      await pool.query(
        `UPDATE byos_connections SET state='disconnected' WHERE id=$1`,
        [connection],
      );
      assert.equal((await settings.botModels(alice)).length, 0);
      await assert.rejects(settings.setBotModel(alice, bot, binding));
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
