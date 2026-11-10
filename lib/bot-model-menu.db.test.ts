import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
// Subscription chats answer only on validated routes (lib/subscription-routes.ts); these tests run with both on.
process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'

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
const quota = (used: number, resetsAt: string, provider = "claude") =>
  JSON.stringify({ vendor: provider === "codex" ? "codex" : "claude_code", source: "official", status: "ok", plan: provider === "codex" ? "Pro" : "Max", windows: [{ kind: "five_hour", used, resetsAt }], observedAt: new Date().toISOString() });

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
      CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY,kind text NOT NULL DEFAULT 'team' CHECK (kind IN ('personal','team')));
      CREATE TABLE mikka_workspace_members ("workspaceId" uuid,"userId" text,name text,status text);
      CREATE TABLE byos_connections (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,epoch bigint,state text,provider text,"accountLabel" text,quota jsonb,"removedAt" timestamptz,paused boolean NOT NULL DEFAULT false,"modelSettings" jsonb);
      CREATE TABLE byos_bindings (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,"consumerId" text,"connectionId" uuid,"connectionRevision" bigint,"modelId" text,route text,"createdAt" timestamptz DEFAULT now())`);
    for (const file of ["20261030193000_device_enrollment_management.sql", "20261030200610_execution_rules.sql", "20261030233002_byos_model_catalog.sql", "20261101001200_bot_model_hosted_choice.sql", "20261101001200_bot_model_hosted_choice.sql", "20261101020201_workspace_personal_policies.sql", "20261101020202_bot_archive.sql", "20261101021000_model_api_keys.sql", "20261101021100_bot_api_key_choice.sql", "20261102120000_model_api_key_models_error.sql", "20261102190000_model_api_key_responses_api.sql"])
      await pool.query(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
    // Resource policy still runs against real non-Org rows in this isolated schema.
    await pool.query(await readFile(new URL("../drizzle/20261109035020_organization_governance.sql", import.meta.url), "utf8"));

    await pool.query(`CREATE TABLE workspace_audit_events (id uuid PRIMARY KEY,"workspaceId" uuid,"actorType" text,"actorName" text,action text,category text,"targetType" text,"targetId" text,metadata jsonb);
      CREATE TABLE byos_native_runs ("runId" uuid,"bindingId" uuid)`);
    await pool.query(`CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"deviceId" uuid,"agentDefinition" jsonb,status text,"stopRequestedAt" timestamptz,"leaseExpiresAt" timestamptz,"updatedAt" timestamptz)`);
    for (const migration of ["20261110020020_personal_subscriptions_organization_connections.sql", "20261110020021_organization_model_policy.sql"]) {
      const sql = await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
      await pool.query(sql);
      await pool.query(sql);
    }
    mock.module(new URL("./db/index.ts", import.meta.url).href, { namedExports: { pool } });
    mock.module(new URL("./workspace-db.ts", import.meta.url).href, { namedExports: { workspaceDb: drizzle(pool), workspacePool: pool } });
    // Points and their fallback have their own tests: here Mikka 默认 has points.
    let hostedPoints = 98;
    let hostedTrial = 0;
    let pointsChoice: { kind: "api_key"; keyId: string; model: string } | null = null;
    mock.module(new URL("./points-fallback.ts", import.meta.url).href, { namedExports: { hostedPointsRefusal: async () => hostedPoints > 0 || hostedTrial > 0 ? null : "points_exhausted", pointsFallback: async () => pointsChoice, hostedPointsHere: async () => ({ points: hostedPoints, trialLeft: hostedTrial }) } });
    const { ExecutionSettings } = await import("./execution-settings");
    const { botModelMenu } = await import("./bot-model-menu");
    const { HOSTED_CHOICE } = await import("./bot-model-menu-view");
    const { freezeBotModel } = await import("./bot-model-selection");
    const { SubscriptionRepository } = await import("./subscription-repository");
    const { COORDINATOR_MODEL } = await import("./coordinator/model");

    const settings = new ExecutionSettings(pool);
    const workspace = randomUUID(), elsewhere = randomUUID();
    await pool.query('INSERT INTO mikka_workspaces(id) VALUES ($1),($2)', [workspace, elsewhere]);
    const alice = { ownerId: "alice", actorId: "alice", workspaceId: workspace };
    const [botA, botB, bobBot] = [randomUUID(), randomUUID(), randomUUID()];
    await pool.query(`INSERT INTO mikka_workspace_members VALUES ($1,'alice','Alice','active'),($1,'bob','Bob','active')`, [workspace]);
    await pool.query(`INSERT INTO bots VALUES ($1,'alice',$4),($2,'alice',$4),($3,'bob',$4)`, [botA, botB, bobBot, workspace]);
    // A team workspace uses a member's subscriptions only once they share them there (decision 2026-10-31-2225).
    await pool.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ('alice',$1),('bob',$1)`, [workspace]);
    const connection = async (owner: string, ws: string, provider: string, state = "connected", q: string | null = null) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO byos_connections VALUES ($1,$2,$3,1,$4,$5,NULL,$6::jsonb)`, [id, owner, ws, state, provider, q ?? quota(0.2, FUTURE, provider)]);
      return id;
    };
    const binding = async (owner: string, ws: string, conn: string, model: string, route: string) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision","modelId",route) VALUES ($1,$2,$3,$7,$4,1,$5,$6)`, [id, owner, ws, conn, model, route, id]);
      return id;
    };
    const claude = await connection("alice", workspace, "claude", "connected", quota(0.2, FUTURE));
    const codex = await connection("alice", workspace, "codex");
    await pool.query(`UPDATE byos_connections SET "accountLabel"='alice-claude@example.test' WHERE id=$1`, [claude]);
    const gone = await connection("alice", workspace, "claude", "disconnected");
    const bobs = await connection("bob", workspace, "claude");
    const otherWs = await connection("alice", elsewhere, "claude");
    const sonnet = await binding("alice", workspace, claude, "claude-sonnet-fixture", "claude_cpa");
    const opus = await binding("alice", workspace, claude, "claude-opus-fixture", "claude_cpa");
    const gpt = await binding("alice", workspace, codex, "gpt-fixture", "codex_cpa");
    const stale = await binding("alice", workspace, gone, "claude-stale-fixture", "claude_cpa");
    const bobsModel = await binding("bob", workspace, bobs, "claude-bob-fixture", "claude_cpa");
    const elsewhereModel = await binding("alice", elsewhere, otherWs, "claude-elsewhere-fixture", "claude_cpa");

    // 1. Only credentials usable here: Mikka 默认, then Claude, then ChatGPT; never another person's or a disconnected one.
    // A subscription is the person's own from any workspace once shared here (decision 2026-10-31-2130), so the
    // Claude account first connected elsewhere is listed too, after this workspace's.
    const menu = await botModelMenu(pool, settings, alice, botA);
    assert.deepEqual(menu.groups.map((group) => [group.kind, group.provider ?? null]), [["hosted", null], ["subscription", "claude"], ["subscription", "claude"], ["subscription", "codex"]]);
    assert.equal(menu.groups[1].plan, "Max");
    assert.equal(menu.groups[1].credentialLabel, "alice-claude@example.test");
    assert.notEqual(menu.groups[1].credentialLabel, menu.groups[2].credentialLabel, "same-provider connections remain identifiable");
    assert.equal(menu.current.credentialLabel, "alice-claude@example.test");
    const listed = menu.groups.flatMap((group) => group.options.map((option) => option.id));
    assert.deepEqual(new Set(listed), new Set([HOSTED_CHOICE, sonnet, opus, gpt, elsewhereModel]));
    for (const id of [stale, bobsModel]) assert.ok(!listed.includes(id));
    // Nothing picked: the chip shows what the resolver gives the next run (Claude first), not a saved choice.
    assert.equal(menu.current.provider, "claude");
    assert.equal(menu.current.chosen, false);
    assert.equal(menu.current.available, true);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM bot_model_choices")).rows[0].n, 0, "reading the menu saves nothing");
    const calls: unknown[][] = [];
    const countedPool = { query: new Proxy(pool.query, { apply(target, _receiver, args) { calls.push(args); return Reflect.apply(target, pool, args) } }) };
    await botModelMenu(countedPool, settings, alice, botA);
    const ordinaryQueryCount = calls.length; calls.length = 0;
    const inspected = await botModelMenu(countedPool, settings, alice, botA, Date.now(), true);
    assert.equal(inspected.preferenceState, "absent");
    assert.equal(calls.length, ordinaryQueryCount, "opt-in presence reuses the existing preference read");
    assert.deepEqual(Object.keys(menu).sort(), ["current", "groups"], "ordinary menu wire shape stays unchanged");
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
    assert.equal((await botModelMenu(pool, settings, alice, botA, Date.now(), true)).preferenceState, "present");
    const coordinator = await botModelMenu(pool, settings, alice, null);
    assert.deepEqual([coordinator.current.id, coordinator.current.kind, coordinator.current.chosen], [HOSTED_CHOICE, "hosted", true]);

    // 3. The Coordinator's picker chooses a model only: no Agent (harness) in its menu.
    assert.ok(!JSON.stringify(coordinator).includes("harness"));
    for (const option of coordinator.groups.flatMap((group) => group.options))
      assert.deepEqual(Object.keys(option).sort(), ["id", "modelId", "provider"]);

    // 4. The next run freezes the pick; a run already frozen keeps its model.
    const dependencies = { service: () => ({ repository: new SubscriptionRepository(pool) }) as never, workspace: async () => {} };
    const runA = await freezeBotModel({ ownerId: "alice", actorId: "alice", botId: botA, workspaceId: workspace }, dependencies);
    assert.equal(runA.model, "gpt-fixture");
    assert.equal((runA.modelSelection as { connectionId?: string } | undefined)?.connectionId, codex);
    assert.deepEqual(await freezeBotModel({ ownerId: "alice", actorId: "alice", botId: null, workspaceId: workspace }, dependencies), { harness: "ai_sdk", model: COORDINATOR_MODEL, actorId: "alice" });
    await settings.setBotModel(alice, botA, opus);
    assert.equal(runA.model, "gpt-fixture", "the frozen run is not switched");
    const nextA = await freezeBotModel({ ownerId: "alice", actorId: "alice", botId: botA, workspaceId: workspace }, dependencies);
    assert.equal(nextA.model, "claude-opus-fixture");
    // The menu ticks the listed option even though the bot keeps its own copy of the binding.
    const picked = await botModelMenu(pool, settings, alice, botA);
    assert.equal(picked.current.id, optionFor(picked, "claude-opus-fixture"));
    assert.equal(picked.current.chosen, true);

    // 5. A disappeared preference offers a replacement but requires a new explicit choice.
    await settings.setBotModel(alice, botB, gpt);
    await pool.query(`UPDATE byos_connections SET state='disconnected' WHERE id=$1`, [codex]);
    const lost = await botModelMenu(pool, settings, alice, botB);
    await assert.rejects(freezeBotModel({ ownerId: "alice", actorId: "alice", botId: botB, workspaceId: workspace }, dependencies), { code: "executionModelUnknown" });
    assert.equal(lost.current.provider, "claude");
    assert.equal(lost.current.chosen, false);
    assert.equal(lost.current.fallback, "preference");
    assert.equal((await pool.query(`SELECT "bindingId" FROM bot_model_choices WHERE "botKey"=$1`, [botB])).rows[0].bindingId !== lost.current.id, true, "reading the fallback preserves the stored preference");
    assert.ok(!lost.groups.some((group) => group.provider === "codex"), "the gone account is no longer offered");
    // Out of quota: a fully used account window that has not reset.
    await pool.query(`UPDATE byos_connections SET quota=$2::jsonb WHERE id=$1`, [claude, quota(1, FUTURE)]);
    assert.equal((await botModelMenu(pool, settings, alice, botA)).current.available, false);
    await pool.query(`UPDATE byos_connections SET quota=$2::jsonb WHERE id=$1`, [claude, JSON.stringify({ ...JSON.parse(quota(1, new Date(Date.now() - 1000).toISOString())), observedAt: new Date(Date.now() - 2000).toISOString() })]);
    const awaitingCheck = await botModelMenu(pool, settings, alice, botA);
    assert.equal(awaitingCheck.current.available, false);
    assert.equal(awaitingCheck.current.availability, "checking", "a local reset time does not confirm allowance");

    // 6. 刷新模型列表: a subscription connected since the menu was read, never asked for its models (no catalogue,
    // no binding: production, 2026-11-02), and a model its provider now offers, show at once.
    const { refreshBotModelMenu } = await import("./bot-model-menu");
    const fresh = await connection("alice", workspace, "claude", "connected");
    assert.ok(!(await botModelMenu(pool, settings, alice, botA)).groups.some((group) => group.options.some((option) => option.modelId === "claude-fresh-fixture")));
    const discovering = {
      chatModels: settings.chatModels.bind(settings),
      chatBinding: settings.chatBinding.bind(settings),
      connectedSubscriptions: settings.connectedSubscriptions.bind(settings),
      refreshBotModels: (scope: typeof alice, connectionId: string) =>
        settings.refreshBotModels(scope, connectionId, async () => connectionId === claude ? [{ id: "claude-sonnet-fixture" }, { id: "claude-opus-fixture" }, { id: "claude-new-fixture" }] : connectionId === fresh ? [{ id: "claude-fresh-fixture" }] : []),
    };
    const quotaReads: string[] = [];
    const refreshQuota = async (_owner: string, connectionId: string) => {
      quotaReads.push(connectionId);
      await pool.query('UPDATE byos_connections SET quota=$2::jsonb WHERE id=$1', [connectionId, quota(0.2, FUTURE)]);
    };
    const refreshed = await refreshBotModelMenu(pool, discovering, alice, botA, 8000, refreshQuota);
    assert.ok(quotaReads.includes(claude));
    assert.equal(refreshed.current.availability, "available", "refresh checks a stale allowance as well as models");
    const models = refreshed.groups.flatMap((group) => group.options.map((option) => option.modelId));
    for (const model of ["claude-new-fixture", "claude-fresh-fixture"]) assert.ok(models.includes(model), model);
    // A provider that does not answer keeps its catalogue; the menu is still read.
    const hanging = { ...discovering, refreshBotModels: () => new Promise<never>(() => {}) };
    const started = Date.now();
    const kept = await refreshBotModelMenu(pool, hanging, alice, botA, 50, refreshQuota);
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(kept.groups.flatMap((group) => group.options.map((option) => option.modelId)).sort(), models.sort());
    // A provider that refuses (signed out, backend down) is skipped the same way.
    const refusing = { ...discovering, refreshBotModels: async () => { throw new Error("provider down"); } };
    assert.ok((await refreshBotModelMenu(pool, refusing, alice, botA, 8000, refreshQuota)).groups.length > 1);

    // 7. Opening the menu asks a connected subscription that was never asked for its models (no 刷新 needed),
    // once per revision; a paused one is not asked.
    const unasked = await connection("alice", workspace, "claude", "connected");
    const pausedOne = await connection("alice", workspace, "claude", "connected");
    await pool.query("UPDATE byos_connections SET paused=true WHERE id=$1", [pausedOne]);
    const asked: string[] = [];
    await settings.ensureCatalogues(alice, 1000, async (_owner, connectionId) => { asked.push(connectionId); return connectionId === unasked ? [{ id: "claude-unasked-fixture" }] : []; });
    assert.ok(asked.includes(unasked));
    assert.ok(!asked.includes(pausedOne));
    assert.ok((await botModelMenu(pool, settings, alice, botA)).groups.some((group) => group.options.some((option) => option.modelId === "claude-unasked-fixture")));
    await settings.ensureCatalogues(alice, 1000, async (_owner, connectionId) => { throw new Error(`asked again: ${connectionId}`); });
    await pool.query("UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1", [unasked]);
    const again: string[] = [];
    await settings.ensureCatalogues(alice, 1000, async (_owner, connectionId) => { again.push(connectionId); return []; });
    assert.deepEqual(again, [unasked], "a reconnect (new revision) is asked again");

    // C22: an API key's models are a menu group, and the Coordinator saved on one runs on it.
    const { addApiKey, setApiKeyAfterQuota } = await import("./model-api-keys");
    const { apiKeyOptionId } = await import("./bot-model-menu-view");
    const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString("hex") };
    const listing = (async () => new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }] }), { status: 200 })) as unknown as typeof fetch;
    const key = await addApiKey(pool, "alice", { provider: "deepseek", apiKey: `test-${randomUUID()}` }, { env, fetch: listing });
    const keyOption = apiKeyOptionId(key.id, "deepseek-chat");
    let keyMenu = await botModelMenu(pool, settings, alice, null);
    assert.equal(keyMenu.groups.find((group) => group.kind === "apiKey")?.credentialLabel, `····${key.last4}`);
    assert.deepEqual(keyMenu.groups.find((group) => group.kind === "apiKey")?.options, [{ id: keyOption, modelId: "deepseek-chat", provider: "deepseek" }]);
    // Picked by its option id, as the web's action and the iOS app's PUT /api/mobile/model both send it.
    const { chooseBotModel } = await import("./bot-model-menu");
    keyMenu = await chooseBotModel(pool, settings, alice, null, keyOption);
    assert.deepEqual([keyMenu.current.id, keyMenu.current.kind, keyMenu.current.chosen, keyMenu.current.available], [keyOption, "apiKey", true, true]);
    assert.deepEqual(await freezeBotModel({ ownerId: "alice", actorId: "alice", botId: null, workspaceId: workspace }, dependencies), {
      harness: "ai_sdk", model: "deepseek-chat", actorId: "alice",
      modelSelection: { coordinator: true, type: "api_key", keyId: key.id, ownerId: "alice", actorId: "alice", workspaceId: workspace, modelId: "deepseek-chat", credentialOwnerId: "alice", credentialRevision: 1 },
    });
    // Mikka 默认 picked after a key model: it is what the chip shows and what the next turn runs on, not the key
    // (production, 2026-11-02: the pick saved, but the old key choice won on read and the chip went back to the key).
    const { HOSTED_CHOICE: hostedChoice } = await import("./bot-model-menu-view");
    const hostedMenu = await chooseBotModel(pool, settings, alice, null, hostedChoice);
    assert.deepEqual([hostedMenu.current.id, hostedMenu.current.kind, hostedMenu.current.chosen, hostedMenu.current.available], [hostedChoice, "hosted", true, true]);
    assert.notEqual((await freezeBotModel({ ownerId: "alice", actorId: "alice", botId: null, workspaceId: workspace }, dependencies)).modelSelection?.type, "api_key");
    assert.equal(hostedMenu.groups.find((group) => group.kind === "hosted")?.points, 98, "the points it can spend in this workspace");
    // No points in this workspace (decision 2026-11-02-1450): not listed; the pick stays, named and unavailable, so the chat says so before sending.
    hostedPoints = 0;
    const noPoints = await botModelMenu(pool, settings, alice, null);
    assert.equal(noPoints.groups.some((group) => group.kind === "hosted"), false);
    assert.deepEqual([noPoints.current.id, noPoints.current.chosen, noPoints.current.available], [hostedChoice, true, false]);
    pointsChoice = { kind: "api_key", keyId: key.id, model: "deepseek-chat" };
    const pointsMenu = await botModelMenu(pool, settings, alice, null);
    const pointsRun = await freezeBotModel({ ownerId: "alice", actorId: "alice", botId: null, workspaceId: workspace }, dependencies);
    assert.equal(pointsMenu.current.kind, "hosted");
    assert.equal(pointsMenu.current.available, false);
    assert.equal(pointsMenu.current.fallback, undefined);
    assert.equal(pointsRun.model, COORDINATOR_MODEL);
    assert.equal(pointsRun.modelSelection, undefined);
    pointsChoice = null;
    // No card yet but free messages left: listed, the tag names them.
    hostedTrial = 12;
    const trial = await botModelMenu(pool, settings, alice, null);
    assert.deepEqual([trial.groups.find((group) => group.kind === "hosted")?.trialLeft, trial.current.available], [12, true]);
    hostedTrial = 0;
    hostedPoints = 98;
    // Picking the key again moves back to it.
    keyMenu = await chooseBotModel(pool, settings, alice, null, keyOption);
    assert.equal(keyMenu.current.id, keyOption);
    // 订阅额度用完后，自动改用 API Key: bot A's Claude subscription is out of quota. The composer names the reset and
    // the key the next turn moves to; that turn is frozen on Alice's own key, marked, and a frozen one never changes.
    await pool.query(`UPDATE byos_connections SET quota=$2::jsonb WHERE id=$1`, [claude, quota(1, FUTURE)]);
    const noSameModel = await botModelMenu(pool, settings, alice, botA);
    assert.equal(noSameModel.current.kind, "subscription", "an unrelated Key cannot replace the frozen subscription model");
    assert.equal(noSameModel.current.quota?.fallback, null);
    const sameModelKey = await addApiKey(pool, "alice", { provider: "anthropic", apiKey: `fixture-compatible-${randomUUID()}` }, {
      env, fetch: (async () => Response.json({ data: [{ id: "claude-opus-fixture" }] })) as unknown as typeof fetch,
    });
    assert.equal((await botModelMenu(pool, settings, alice, botA)).current.kind, "subscription", "default false does not authorize spending a paid key");
    await setApiKeyAfterQuota(pool, "alice", true);
    const out = await botModelMenu(pool, settings, alice, botA);
    // The chip names the key's model the next turn runs on.
    assert.deepEqual([out.current.id, out.current.modelId, out.current.kind, out.current.available], [apiKeyOptionId(sameModelKey.id, "claude-opus-fixture"), "claude-opus-fixture", "apiKey", true]);
    assert.deepEqual(out.current.quota, { subscription: "claude", plan: "Max", resetsAt: FUTURE, fallback: { keyProvider: "anthropic", keyName: null, model: "claude-opus-fixture" } });
    const switched = await freezeBotModel({ ownerId: "alice", actorId: "alice", botId: botA, workspaceId: workspace }, dependencies);
    assert.deepEqual(switched, {
      harness: "ai_sdk", model: "claude-opus-fixture",
      modelSelection: { consumerId: botA, type: "api_key", keyId: sameModelKey.id, ownerId: "alice", workspaceId: workspace, modelId: "claude-opus-fixture", credentialOwnerId: "alice", credentialRevision: 1,
        afterQuota: { subscription: "claude", plan: "Max", keyProvider: "anthropic", keyName: null } },
    });
    // Turned off: the turn stays on the subscription and stops there; the composer offers 添加 API Key 继续 instead.
    await setApiKeyAfterQuota(pool, "alice", false);
    const off = await botModelMenu(pool, settings, alice, botA);
    assert.deepEqual([off.current.modelId, off.current.available, off.current.quota?.fallback], ["claude-opus-fixture", false, null]);
    const stays = await freezeBotModel({ ownerId: "alice", actorId: "alice", botId: botA, workspaceId: workspace }, dependencies);
    assert.equal(stays.modelSelection?.type, "subscription");
    // A teammate's key is never spent this way: Alice shares hers with the team, Bob can pick it, but his bot on his
    // exhausted subscription does not move to it.
    await setApiKeyAfterQuota(pool, "alice", true);
    await setApiKeyAfterQuota(pool, "bob", true);
    const { setApiKeyShare, usableApiKeys } = await import("./model-api-keys");
    await setApiKeyShare(pool, "alice", { id: workspace, kind: "team" }, key.id, true);
    assert.ok((await usableApiKeys(pool, "bob", workspace)).some((row) => row.id === key.id && !row.mine));
    await pool.query(`UPDATE byos_connections SET quota=$2::jsonb WHERE id=$1`, [bobs, quota(1, FUTURE)]);
    const bobsTurn = await freezeBotModel({ ownerId: "bob", actorId: "bob", botId: bobBot, workspaceId: workspace }, dependencies);
    assert.notEqual(bobsTurn.modelSelection?.type, "api_key");
    // Fresh provider allowance after reset: the subscription runs again.
    await pool.query(`UPDATE byos_connections SET quota=$2::jsonb WHERE id=$1`, [claude, quota(0.2, FUTURE)]);
    assert.equal((await freezeBotModel({ ownerId: "alice", actorId: "alice", botId: botA, workspaceId: workspace }, dependencies)).modelSelection?.type, "subscription");

    // Shared keys identify both their owner and their masked key, then disappear on withdrawal.
    const sharedMenu = await botModelMenu(pool, settings, { ownerId: "bob", workspaceId: workspace }, bobBot);
    assert.equal(sharedMenu.groups.find(group => group.kind === "shared")?.owner, "Alice");
    assert.equal(sharedMenu.groups.find(group => group.kind === "shared")?.credentialLabel, `····${key.last4}`);
    await chooseBotModel(pool, settings, { ownerId: "bob", workspaceId: workspace }, bobBot, keyOption);
    const pickedSharedKey = await botModelMenu(pool, settings, { ownerId: "bob", workspaceId: workspace }, bobBot);
    assert.equal(pickedSharedKey.current.credentialLabel, `Alice · ····${key.last4}`, "the current shared credential identifies who pays");
    await pool.query(`DELETE FROM model_api_key_shares WHERE "keyId"=$1 AND "workspaceId"=$2`, [key.id, workspace]);
    assert.equal((await botModelMenu(pool, settings, { ownerId: "bob", workspaceId: workspace }, bobBot)).groups.some(group => group.kind === "shared"), false);
    // Same model from two keys remains two identifiable credentials.
    const secondKey = await addApiKey(pool, "alice", { provider: "kimi", apiKey: `test-second-${randomUUID()}` }, { env, fetch: listing });
    const twoKeys = (await botModelMenu(pool, settings, alice, null)).groups.filter(group => group.kind === "apiKey" && group.options.some(option => option.modelId === "deepseek-chat"));
    assert.equal(twoKeys.length, 2);
    assert.deepEqual(new Set(twoKeys.map(group => group.credentialLabel)), new Set([`····${key.last4}`, `····${secondKey.last4}`]));
    // A withdrawn saved key offers a suggestion but cannot charge it without a new choice.
    await chooseBotModel(pool, settings, alice, null, keyOption);
    await pool.query(`UPDATE model_api_keys SET models='[]'::jsonb WHERE id=$1`, [key.id]);
    const lostKeyMenu = await botModelMenu(pool, settings, alice, null);
    await assert.rejects(freezeBotModel({ ownerId: "alice", actorId: "alice", botId: null, workspaceId: workspace }, dependencies), { code: "executionModelUnknown" });
    assert.equal(lostKeyMenu.current.fallback, "preference");

    // Legacy grants and guessed binding ids never expose or authorize another member subscription.
    const bob = { ownerId: "bob", actorId: "bob", workspaceId: workspace };
    await assert.rejects(pool.query(`UPDATE workspace_subscription_shares SET "allowOthers"=true WHERE "ownerId"='alice' AND "workspaceId"=$1`, [workspace]), { code: "23514" });
    await pool.query(`UPDATE byos_connections SET state='connected', paused=false, epoch=1, "removedAt"=NULL WHERE id=ANY($1::uuid[])`, [[claude, codex]]);
    const haiku = await binding("alice", workspace, claude, "claude-haiku-5-5", "claude_cpa");
    const luna = await binding("alice", workspace, codex, "gpt-6-luna", "codex_cpa");
    await pool.query(`UPDATE byos_connections SET "accountLabel"='PRIVATE-LOGIN-SENTINEL', quota=$3::jsonb,
      "modelCatalog"=jsonb_build_object('revision','1','models',jsonb_build_array($2::text)) WHERE id=$1`, [claude, "claude-haiku-5-5", quota(0.2, FUTURE)]);
    await pool.query(`UPDATE byos_connections SET quota=$3::jsonb,
      "modelCatalog"=jsonb_build_object('revision','1','models',jsonb_build_array($2::text)) WHERE id=$1`, [codex, "gpt-6-luna", quota(0.2, FUTURE, "codex")]);
    const sharedModels = await botModelMenu(pool, settings, bob, bobBot);
    assert.deepEqual(sharedModels.groups.filter(group => group.kind === "subscription" && group.owner === "Alice"), []);
    assert.ok(!JSON.stringify(sharedModels).includes("PRIVATE-LOGIN-SENTINEL"));
    for (const selected of [haiku, luna]) await assert.rejects(chooseBotModel(pool, settings, bob, bobBot, selected), { code: "executionModelUnknown" });
    // A saved choice migrated from the historical borrower mode also fails.
    const savedShared = randomUUID();
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision","modelId",route)
      VALUES ($1,'alice',$2,$3,$4,1,'gpt-6-luna','codex_cpa')`, [savedShared, workspace, bobBot, codex]);
    await pool.query(`UPDATE bot_model_choices SET "bindingId"=$3,"apiKeyId"=NULL WHERE "ownerId"='bob' AND "workspaceId"=$1 AND "botKey"=$2`, [workspace, bobBot, savedShared]);
    assert.equal(await settings.sharedChatBinding(bob, bobBot, savedShared), undefined);
    await assert.rejects(freezeBotModel({ ...bob, botId: bobBot }, dependencies), { code: "executionModelUnknown" });
    const latestLuna = await binding("alice", workspace, codex, "gpt-6-luna", "codex_cpa");
    const deduped = await botModelMenu(pool, settings, bob, bobBot);
    assert.ok(!deduped.groups.flatMap(group => group.options).some(option => option.id === latestLuna || option.modelId === "gpt-6-luna"));
    assert.equal(deduped.current.chosen, false);

    await assert.rejects(chooseBotModel(pool, settings, bob, botA, luna), { code: "botNotFound" });
    await assert.rejects(chooseBotModel(pool, settings, { ...bob, workspaceId: elsewhere }, bobBot, luna), { code: "botNotFound" });
    const elsewhereBot = randomUUID();
    await pool.query(`INSERT INTO bots(id,"ownerId","workspaceId") VALUES ($1,'bob',$2)`, [elsewhereBot, elsewhere]);
    await assert.rejects(chooseBotModel(pool, settings, { ...bob, workspaceId: elsewhere }, elsewhereBot, luna), { code: "executionModelUnknown" });
    await pool.query('UPDATE bots SET "archivedAt"=now() WHERE id=$1', [bobBot]);
    await assert.rejects(chooseBotModel(pool, settings, bob, bobBot, luna), { code: "botNotFound" });
    await pool.query('UPDATE bots SET "archivedAt"=NULL WHERE id=$1', [bobBot]);

    for (const [change, restore] of [["paused=true", "paused=false"], ["state='disconnected'", "state='connected'"],
      ["epoch=2", "epoch=1"], ['"removedAt"=now()', '"removedAt"=NULL']]) {
      await pool.query(`UPDATE byos_connections SET ${change} WHERE id=$1`, [codex]);
      assert.equal(await settings.sharedChatBinding(bob, bobBot, savedShared), undefined);
      await assert.rejects(chooseBotModel(pool, settings, bob, bobBot, luna), { code: "executionModelUnknown" });
      const unavailable = await botModelMenu(pool, settings, bob, bobBot);
      assert.ok(!unavailable.groups.some(group => group.owner === "Alice" && group.options.some(option => option.modelId === "gpt-6-luna")));
      await pool.query(`UPDATE byos_connections SET ${restore} WHERE id=$1`, [codex]);
    }
    await pool.query(`UPDATE byos_connections SET quota=$2::jsonb WHERE id=$1`, [codex, quota(1, FUTURE, "codex")]);
    const exhaustedShared = await botModelMenu(pool, settings, bob, bobBot);
    assert.ok(!exhaustedShared.groups.some(group => group.owner === "Alice"));
    assert.notEqual(exhaustedShared.current.modelId, "gpt-6-luna");
    await assert.rejects(freezeBotModel({ ...bob, botId: bobBot }, dependencies), { code: "executionModelUnknown" });
    await pool.query(`UPDATE byos_connections SET quota=$2::jsonb WHERE id=$1`, [codex, quota(0.2, FUTURE, "codex")]);

    for (const owner of ["alice", "bob"]) {
      await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspace, owner]);
      await assert.rejects(chooseBotModel(pool, settings, bob, bobBot, luna));
      if (owner === "alice") assert.equal((await settings.pooledBindings(bob)).length, 0);
      else await assert.rejects(settings.pooledBindings(bob), { code: "workspaceAccessDenied" });
      await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspace, owner]);
    }
    await pool.query(`INSERT INTO workspace_personal_policies("workspaceId",subscriptions) VALUES ($1,false)
      ON CONFLICT("workspaceId") DO UPDATE SET subscriptions=false`, [workspace]);
    await assert.rejects(chooseBotModel(pool, settings, bob, bobBot, luna), { code: "executionModelUnknown" });
    assert.equal(await settings.sharedChatBinding(bob, bobBot, savedShared), undefined);
    await pool.query('UPDATE workspace_personal_policies SET subscriptions=true WHERE "workspaceId"=$1', [workspace]);
    await pool.query(`UPDATE workspace_subscription_shares SET "allowOthers"=false WHERE "ownerId"='alice' AND "workspaceId"=$1`, [workspace]);
    await assert.rejects(chooseBotModel(pool, settings, bob, bobBot, luna), { code: "executionModelUnknown" });
    assert.equal(await settings.sharedChatBinding(bob, bobBot, savedShared), undefined);
    assert.ok(!(await botModelMenu(pool, settings, bob, bobBot)).groups.some(group => group.owner === "Alice"));
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("mobile model API keeps normal selection and authenticates every temporary branch", async () => {
  mock.reset(); // The preceding database fixture has completed; retire its module mocks.
  const owner = "model-route-fixture-owner", bot = "10000000-0000-4000-8000-000000000001";
  const workspace = "10000000-0000-4000-8000-000000000002", option = "10000000-0000-4000-8000-000000000003";
  const stored = "10000000-0000-4000-8000-000000000004";
  const calls: { method: string; args: unknown[] }[] = [];
  const normal = { groups: [], current: { id: option } };
  let authenticated = true, originAllowed = true, conflict = false, restored = true;
  const tokenWorkspace = Symbol("fixture-token-workspace");
  const { ActionFailureError } = await import("./action-error");
  const record = (method: string, args: unknown[]) => { calls.push({ method, args }); };
  const mocks = [
    mock.module(new URL("./request-log.ts", import.meta.url).href, { namedExports: { noteLogUser: () => {}, withRequestLog: (_name: string, handler: unknown) => handler } }),
    mock.module(new URL("./mobile-api.ts", import.meta.url).href, { namedExports: {
      mobileUser: async () => authenticated ? { id: owner, [tokenWorkspace]: workspace } : null,
      writeAllowed: () => originAllowed, json: (value: unknown, status = 200) => Response.json(value, { status }),
      unauthorized: () => Response.json({ error: "authRequired" }, { status: 401 }),
      forbiddenOrigin: () => Response.json({ error: "forbiddenOrigin" }, { status: 403 }),
    } }),
    mock.module(new URL("./tokens/principal.ts", import.meta.url).href, { namedExports: { tokenWorkspace } }),
    mock.module(new URL("./coordinator/coordinator-bot.ts", import.meta.url).href, { namedExports: { openChatBotId: async (_user: unknown, id: string | null) => id ?? bot } }),
    mock.module(new URL("./db/index.ts", import.meta.url).href, { namedExports: { pool: {} } }),
    mock.module(new URL("./execution-settings.ts", import.meta.url).href, { namedExports: { ExecutionSettings: class {
      async setTemporaryBotModel(...args: unknown[]) { record("temporary", args); return conflict ? null : { bindingId: stored, revision: "12345" }; }
      async restoreTemporaryBotModel(...args: unknown[]) { record("restore", args); return restored; }
    } } }),
    mock.module(new URL("./bot-model-menu.ts", import.meta.url).href, { namedExports: {
      botModelScope: async (ownerId: string, botId: string, onlyWorkspace: string) => {
        assert.deepEqual([ownerId, onlyWorkspace], [owner, workspace]);
        if (botId !== bot) throw new ActionFailureError("botNotFound");
        return { ownerId, workspaceId: workspace };
      },
      botModelMenu: async (...args: unknown[]) => { record("menu", args); return { ...normal, ...(args[5] === true ? { preferenceState: "absent" } : {}) }; },
      chooseBotModel: async (...args: unknown[]) => { record("ordinary", args); return normal; },
      refreshBotModelMenu: async () => normal,
    } }),
  ];
  try {
    const route = await import("../app/api/mobile/model/route");
    const request = (body: unknown) => new Request("https://example.test/api/mobile/model", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.deepEqual(await (await route.GET(new Request("https://example.test/api/mobile/model?bot=" + bot))).json(), normal);
    assert.equal(calls.at(-1)?.args.length, 4, "ordinary GET does not opt into extra fields");
    assert.equal((await (await route.GET(new Request("https://example.test/api/mobile/model?bot=" + bot + "&choiceState=1"))).json()).preferenceState, "absent");
    assert.deepEqual(await (await route.PUT(request({ bot, id: option }))).json(), normal);
    assert.equal(calls.at(-1)?.method, "ordinary");
    assert.deepEqual(calls.at(-1)?.args.slice(2), [{ ownerId: owner, workspaceId: workspace }, bot, option]);

    const temporary = { bot, id: option, mode: "temporary-if-absent" };
    const selected = await route.PUT(request(temporary));
    assert.equal(selected.status, 200);
    assert.deepEqual((await selected.json()).temporarySelection, { bindingId: stored, revision: "12345" });
    const restore = { bot, mode: "restore-implicit", bindingId: stored, revision: "12345" };
    assert.deepEqual(await (await route.PUT(request(restore))).json(), { restored: true, preferenceState: "absent" });
    conflict = true; assert.equal((await route.PUT(request(temporary))).status, 409); conflict = false;
    restored = false; assert.equal((await route.PUT(request(restore))).status, 409); restored = true;

    for (const body of [{ ...temporary, workspaceId: workspace }, { ...temporary, bot: null },
      { ...temporary, id: "apikey:private" }, { ...restore, revision: "PRIVATE_BODY" }, { ...restore, unexpected: true }]) {
      const before = calls.length;
      assert.equal((await route.PUT(request(body))).status, 400);
      assert.equal(calls.length, before, "invalid input never reaches storage");
    }
    for (const body of [temporary, restore]) {
      authenticated = false; const before = calls.length;
      assert.equal((await route.PUT(request(body))).status, 401); assert.equal(calls.length, before);
      authenticated = true; originAllowed = false;
      assert.equal((await route.PUT(request(body))).status, 403); assert.equal(calls.length, before);
      originAllowed = true;
      assert.equal((await route.PUT(request({ ...body, bot: stored }))).status, 404); assert.equal(calls.length, before);
    }
  } finally { for (const handle of mocks.reverse()) handle.restore(); }
});
