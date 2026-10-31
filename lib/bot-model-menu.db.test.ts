import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

/*
 * The composer's model picker against real Postgres (decision 2026-10-31-2330):
 * only usable credentials are listed, the choice is saved per bot, the
 * Coordinator's menu holds models only, a credential that went away shows as
 * unavailable, and the next run freezes the model the person picked.
 */
const databaseURL = process.env.E2E_DATABASE_URL;
if (process.env.REQUIRE_DB === "1" && !databaseURL)
  throw new Error("Bot model menu database test URL required");

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const quota = (used: number, resetsAt: string) =>
  JSON.stringify({ vendor: "claude_code", source: "official", status: "ok", plan: "Max", windows: [{ kind: "five_hour", used, resetsAt }], observedAt: PAST });

test("bot model menu: usable credentials, per-bot choice, Coordinator, unavailable, next run", { skip: !databaseURL }, async () => {
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(databaseURL!).hostname));
  assert.equal(new URL(databaseURL!).pathname, "/mikka_e2e");
  const admin = new Pool({ connectionString: databaseURL });
  const schema = `bot_menu_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES ('alice'),('bob');
      CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,kind text,"removedAt" timestamptz,"lastSeenAt" timestamptz,enabled boolean,"deviceType" text,name text,harnesses jsonb,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid);
      CREATE TABLE byos_connections (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,epoch bigint,state text,provider text,"accountLabel" text,quota jsonb);
      CREATE TABLE byos_bindings (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,"consumerId" text,"connectionId" uuid,"connectionRevision" bigint,"modelId" text,route text,"createdAt" timestamptz DEFAULT now())`);
    for (const file of ["20261030193000_device_enrollment_management.sql", "20261030200610_execution_rules.sql", "20261030233002_byos_model_catalog.sql", "20261031233000_bot_model_hosted_choice.sql", "20261031233000_bot_model_hosted_choice.sql"])
      await pool.query(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));

    mock.module(new URL("./db/index.ts", import.meta.url).href, { namedExports: { pool } });
    const { ExecutionSettings } = await import("./execution-settings");
    const { botModelMenu } = await import("./bot-model-menu");
    const { HOSTED_CHOICE } = await import("./bot-model-menu-view");
    const { freezeBotModel } = await import("./bot-model-selection");
    const { SubscriptionRepository } = await import("./subscription-repository");
    const { COORDINATOR_MODEL } = await import("./coordinator/model");

    const settings = new ExecutionSettings(pool);
    const workspace = randomUUID(), elsewhere = randomUUID();
    const alice = { ownerId: "alice", workspaceId: workspace };
    const [botA, botB, bobBot] = [randomUUID(), randomUUID(), randomUUID()];
    await pool.query(`INSERT INTO bots VALUES ($1,'alice',$4),($2,'alice',$4),($3,'bob',$4)`, [botA, botB, bobBot, workspace]);
    const connection = async (owner: string, ws: string, provider: string, state = "connected", q: string | null = null) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO byos_connections VALUES ($1,$2,$3,1,$4,$5,NULL,$6::jsonb)`, [id, owner, ws, state, provider, q]);
      return id;
    };
    const binding = async (owner: string, ws: string, conn: string, model: string, route: string) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision","modelId",route) VALUES ($1,$2,$3,$7,$4,1,$5,$6)`, [id, owner, ws, conn, model, route, id]);
      return id;
    };
    const claude = await connection("alice", workspace, "claude", "connected", quota(0.2, FUTURE));
    const codex = await connection("alice", workspace, "codex");
    const gone = await connection("alice", workspace, "claude", "disconnected");
    const bobs = await connection("bob", workspace, "claude");
    const otherWs = await connection("alice", elsewhere, "claude");
    const sonnet = await binding("alice", workspace, claude, "claude-sonnet-fixture", "claude_cpa");
    const opus = await binding("alice", workspace, claude, "claude-opus-fixture", "claude_cpa");
    const gpt = await binding("alice", workspace, codex, "gpt-fixture", "codex_cpa");
    const stale = await binding("alice", workspace, gone, "claude-stale-fixture", "claude_cpa");
    const bobsModel = await binding("bob", workspace, bobs, "claude-bob-fixture", "claude_cpa");
    const elsewhereModel = await binding("alice", elsewhere, otherWs, "claude-elsewhere-fixture", "claude_cpa");

    // 1. Only credentials usable here: Mikka 默认, then Claude, then ChatGPT; never another person's, another workspace's or a disconnected one.
    const menu = await botModelMenu(pool, settings, alice, botA);
    assert.deepEqual(menu.groups.map((group) => [group.kind, group.provider ?? null]), [["hosted", null], ["subscription", "claude"], ["subscription", "codex"]]);
    assert.equal(menu.groups[1].plan, "Max");
    const listed = menu.groups.flatMap((group) => group.options.map((option) => option.id));
    assert.deepEqual(new Set(listed), new Set([HOSTED_CHOICE, sonnet, opus, gpt]));
    for (const id of [stale, bobsModel, elsewhereModel]) assert.ok(!listed.includes(id));
    // Nothing picked: the chip shows what the resolver gives the next run (Claude first), not a saved choice.
    assert.equal(menu.current.provider, "claude");
    assert.equal(menu.current.chosen, false);
    assert.equal(menu.current.available, true);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bot_model_choices")).rows[0].n, 0, "reading the menu saves nothing");
    // Another person's bot is not this person's to pick for.
    await assert.rejects(settings.setBotModel(alice, bobBot, gpt), { code: "botNotFound" });
    await assert.rejects(settings.setBotModel(alice, botA, bobsModel), { code: "executionModelUnknown" });
    await assert.rejects(settings.setBotModel(alice, botA, stale), { code: "executionModelUnknown" });

    // 2. Saved per bot: bot A takes GPT, bot B stays on the default, the Coordinator takes Mikka 默认.
    await settings.setBotModel(alice, botA, gpt);
    await settings.setBotModel(alice, null, HOSTED_CHOICE);
    const a = await botModelMenu(pool, settings, alice, botA);
    const optionFor = (menu: Awaited<ReturnType<typeof botModelMenu>>, model: string) => menu.groups.flatMap((group) => group.options).find((option) => option.modelId === model)?.id;
    // The bot runs on its own copy of the binding; the menu ticks the one option for that account and model.
    assert.deepEqual([a.current.id, a.current.modelId, a.current.chosen, a.current.available], [optionFor(a, "gpt-fixture"), "gpt-fixture", true, true]);
    assert.equal(a.groups.flatMap((group) => group.options).filter((option) => option.modelId === "gpt-fixture").length, 1);
    const b = await botModelMenu(pool, settings, alice, botB);
    assert.deepEqual([b.current.provider, b.current.chosen], ["claude", false]);
    const coordinator = await botModelMenu(pool, settings, alice, null);
    assert.deepEqual([coordinator.current.id, coordinator.current.kind, coordinator.current.chosen], [HOSTED_CHOICE, "hosted", true]);

    // 3. The Coordinator's picker chooses a model only: no Agent (harness) in its menu.
    assert.ok(!JSON.stringify(coordinator).includes("harness"));
    for (const option of coordinator.groups.flatMap((group) => group.options))
      assert.deepEqual(Object.keys(option).sort(), ["id", "modelId", "provider"]);

    // 4. The next run freezes the pick; a run already frozen keeps its model.
    const dependencies = { service: () => ({ repository: new SubscriptionRepository(pool) }) as never, workspace: async () => {} };
    const runA = await freezeBotModel({ ownerId: "alice", botId: botA, workspaceId: workspace }, dependencies);
    assert.equal(runA.model, "gpt-fixture");
    assert.equal(runA.modelSelection?.connectionId, codex);
    assert.deepEqual(await freezeBotModel({ ownerId: "alice", botId: null, workspaceId: workspace }, dependencies), { harness: "ai_sdk", model: COORDINATOR_MODEL });
    await settings.setBotModel(alice, botA, opus);
    assert.equal(runA.model, "gpt-fixture", "the frozen run is not switched");
    const nextA = await freezeBotModel({ ownerId: "alice", botId: botA, workspaceId: workspace }, dependencies);
    assert.equal(nextA.model, "claude-opus-fixture");
    // The menu ticks the listed option even though the bot keeps its own copy of the binding.
    const picked = await botModelMenu(pool, settings, alice, botA);
    assert.equal(picked.current.id, optionFor(picked, "claude-opus-fixture"));
    assert.equal(picked.current.chosen, true);

    // 5. A chosen credential that goes away shows as unavailable, under its own name.
    await settings.setBotModel(alice, botB, gpt);
    await pool.query(`UPDATE byos_connections SET state='disconnected' WHERE id=$1`, [codex]);
    const lost = await botModelMenu(pool, settings, alice, botB);
    assert.deepEqual([lost.current.modelId, lost.current.provider, lost.current.chosen, lost.current.available], ["gpt-fixture", "codex", true, false]);
    assert.ok(!lost.groups.some((group) => group.provider === "codex"), "the gone account is no longer offered");
    // Out of quota: a fully used account window that has not reset.
    await pool.query(`UPDATE byos_connections SET quota=$2::jsonb WHERE id=$1`, [claude, quota(1, FUTURE)]);
    assert.equal((await botModelMenu(pool, settings, alice, botA)).current.available, false);
    await pool.query(`UPDATE byos_connections SET quota=$2::jsonb WHERE id=$1`, [claude, quota(1, PAST)]);
    assert.equal((await botModelMenu(pool, settings, alice, botA)).current.available, true);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
