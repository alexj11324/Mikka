import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { ExecutionSettings } from "./execution-settings";
// Subscription chats answer only on validated routes (lib/subscription-routes.ts); these tests run with both on.
process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'
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
      // Install the existing points fixture before the first menu import.
      mock.module(new URL("./points-fallback.ts", import.meta.url).href, { namedExports: { hostedPointsRefusal: async () => null, pointsFallback: async () => null, hostedPointsHere: async () => ({ points: 98, trialLeft: 0 }) } });
      await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES ('alice'),('bob');
      CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,kind text,"removedAt" timestamptz,"lastSeenAt" timestamptz,enabled boolean,"autoSchedule" boolean,"deviceType" text,name text,harnesses jsonb,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,"archivedAt" timestamptz);
      CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY);
      CREATE TABLE mikka_workspace_members ("workspaceId" uuid,"userId" text,name text,status text);
      CREATE TABLE byos_connections (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,epoch bigint,state text,provider text,"accountLabel" text,quota jsonb,"removedAt" timestamptz,paused boolean NOT NULL DEFAULT false,"modelSettings" jsonb);
      CREATE TABLE byos_bindings (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,"consumerId" text,"connectionId" uuid,"connectionRevision" bigint,"modelId" text,route text,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE workspace_e2b_keys ("workspaceId" uuid PRIMARY KEY,"createdBy" text);
      CREATE TABLE user_e2b_keys ("userId" text PRIMARY KEY);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,status text,"stopRequestedAt" timestamptz,"leaseExpiresAt" timestamptz,"updatedAt" timestamptz);
      CREATE TABLE byos_native_runs ("runId" uuid PRIMARY KEY,"bindingId" uuid)`);
      await pool.query(
        await readFile(
          new URL(
            "../drizzle/20261030193000_device_enrollment_management.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const migration = await readFile(
        new URL(
          "../drizzle/20261030200610_execution_rules.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(migration);
      await pool.query(await readFile(new URL("../drizzle/20261101001200_bot_model_hosted_choice.sql", import.meta.url), "utf8"));
      // Un-sharing also stops runs on the owner's API keys (lib/model-api-key-runs.ts).
      await pool.query(
        await readFile(new URL("../drizzle/20261101021000_model_api_keys.sql", import.meta.url), "utf8"),
      );
      await pool.query(
        await readFile(new URL("../drizzle/20261101021100_bot_api_key_choice.sql", import.meta.url), "utf8"),
      );
      await pool.query(
        await readFile(new URL("../drizzle/20261102120000_model_api_key_models_error.sql", import.meta.url), "utf8"),
      );
      await pool.query(
        await readFile(new URL("../drizzle/20261102190000_model_api_key_responses_api.sql", import.meta.url), "utf8"),
      );
      const catalogueMigration = await readFile(new URL('../drizzle/20261030233002_byos_model_catalog.sql',import.meta.url),'utf8');
      await pool.query(catalogueMigration); await pool.query(catalogueMigration);
      const personalPolicyMigration = await readFile(new URL("../drizzle/20261101020201_workspace_personal_policies.sql",import.meta.url),"utf8");
      await pool.query(personalPolicyMigration); await pool.query(personalPolicyMigration);
      const settings = new ExecutionSettings(pool),
        alice = { ownerId: "alice", workspaceId: randomUUID() },
        bob = { ...alice, ownerId: "bob" },
        other = { ...alice, workspaceId: randomUUID() };
      // As the migration does for existing connections: each person's subscriptions stay shared where they were connected.
      for (const scope of [alice, bob]) await pool.query('INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2)', [scope.ownerId, scope.workspaceId]);
      const own = randomUUID(),
        foreign = randomUUID(),
        bot = randomUUID(),
        binding = randomUUID(),
        connection = randomUUID();
      await pool.query(
        `INSERT INTO devices (id,"ownerId",kind,enabled,"autoSchedule","lastSeenAt",harnesses) VALUES ($1,'alice','local',true,true,now(),'[{"harness":"codex","installed":true,"models":["explicit-model"],"defaultModelSlot":"default","modelSlots":[{"slot":"default","model":"explicit-model","name":"Explicit model"}]}]'),($2,'bob','local',true,true,now(),'[]')`,
        [own, foreign],
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

      // Temporary picks never overwrite a preference; the receipt names the stored clone.
      const temporaryBot = randomUUID();
      await pool.query("INSERT INTO bots VALUES ($1,$2,$3)", [temporaryBot, alice.ownerId, alice.workspaceId]);
      await assert.rejects(settings.setTemporaryBotModel(bob, temporaryBot, binding), { code: "botNotFound" });
      await assert.rejects(settings.setTemporaryBotModel(other, temporaryBot, binding), { code: "botNotFound" });
      const temporary = await settings.setTemporaryBotModel(alice, temporaryBot, binding);
      assert.ok(temporary);
      assert.notEqual(temporary.bindingId, binding);
      assert.match(temporary.revision, /^[0-9]+$/);
      const savedTemporary = (await pool.query('SELECT "bindingId",xmin::text AS revision FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
        [alice.ownerId, alice.workspaceId, temporaryBot])).rows[0];
      assert.deepEqual(savedTemporary, temporary);
      assert.equal(await settings.setTemporaryBotModel(alice, temporaryBot, binding), null);
      const conflictingBinding = randomUUID();
      await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision","modelId",route) VALUES ($1::uuid,'alice',$2,$1::text,$3,1,'conflict-model','codex_cpa')`,
        [conflictingBinding, alice.workspaceId, connection]);
      const countBeforeConflict = (await pool.query('SELECT count(*)::int AS count FROM byos_bindings')).rows[0].count;
      assert.equal(await settings.setTemporaryBotModel(alice, temporaryBot, conflictingBinding), null);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM byos_bindings')).rows[0].count, countBeforeConflict, 'a clone created before the conflict is rolled back');
      assert.deepEqual((await pool.query('SELECT "bindingId",xmin::text AS revision FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
        [alice.ownerId, alice.workspaceId, temporaryBot])).rows[0], temporary);
      await pool.query('DELETE FROM byos_bindings WHERE id=$1', [conflictingBinding]);
      assert.equal(await settings.restoreTemporaryBotModel(bob, temporaryBot, temporary), false);
      assert.equal(await settings.restoreTemporaryBotModel(other, temporaryBot, temporary), false);
      assert.equal(await settings.restoreTemporaryBotModel(alice, bot, temporary), false);
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, { ...temporary, bindingId: binding }), false);
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, { ...temporary, revision: String(Number(temporary.revision) + 1) }), false);
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, temporary), true);
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, temporary), false);

      const sameValue = await settings.setTemporaryBotModel(alice, temporaryBot, binding);
      assert.ok(sameValue);
      const rewritten = (await pool.query('UPDATE bot_model_choices SET "bindingId"="bindingId" WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3 RETURNING xmin::text AS revision',
        [alice.ownerId, alice.workspaceId, temporaryBot])).rows[0];
      assert.notEqual(rewritten.revision, sameValue.revision);
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, sameValue), false, 'same value is a different committed row version');
      const temporaryApiKey = randomUUID();
      await pool.query('INSERT INTO model_api_keys (id,"ownerId",provider,protocol,ciphertext,iv,"keyVersion",last4) VALUES ($1,$2,\'custom\',\'openai\',\'fixture_ciphertext\',\'fixture_iv\',1,\'0000\')',
        [temporaryApiKey, alice.ownerId]);
      const apiKeyRewrite = (await pool.query('UPDATE bot_model_choices SET "bindingId"=NULL,"apiKeyId"=$4,"apiKeyModel"=\'fixture-model\' WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3 RETURNING xmin::text AS revision',
        [alice.ownerId, alice.workspaceId, temporaryBot, temporaryApiKey])).rows[0];
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, { ...sameValue, revision: apiKeyRewrite.revision }), false, 'an API-key replacement is never cleared');
      await pool.query('DELETE FROM model_api_keys WHERE id=$1', [temporaryApiKey]);
      await pool.query('DELETE FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3', [alice.ownerId, alice.workspaceId, temporaryBot]);
      const racing = await Promise.all([
        settings.setTemporaryBotModel(alice, temporaryBot, binding),
        settings.setTemporaryBotModel(alice, temporaryBot, binding),
      ]);
      assert.equal(racing.filter(Boolean).length, 1);
      assert.equal(racing.filter(value => value === null).length, 1);
      const winner = racing.find(value => value !== null)!;
      assert.equal(await settings.restoreTemporaryBotModel(alice, temporaryBot, winner), true);
      assert.equal((await pool.query('SELECT 1 FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3', [alice.ownerId, alice.workspaceId, temporaryBot])).rowCount, 0);

      await assert.rejects(settings.setBotModel(bob, bot, binding));
      await assert.rejects(settings.setBotModel(other, bot, binding));
      await settings.setBotModel(alice, bot, binding);
      assert.equal(await settings.botModel(alice, bot), binding);
      await assert.rejects(settings.setBotModel(alice, bot, null),{code:"executionAutoNotAllowed"});
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
      assert.equal((await settings.botModels(alice)).length, 1, 'copied Bot bindings do not duplicate models');
      assert.equal((await settings.botBinding(alice,binding)).bindingId,binding,'runtime can resolve a hidden original binding');
      assert.equal(await settings.botBinding(bob,binding),undefined,'runtime binding lookups remain scoped');
      await settings.setBotModel(alice, secondBot, copiedBinding!);
      assert.equal(await settings.botModel(alice, secondBot), copiedBinding, 'a saved duplicate binding remains selectable');
      await pool.query(`UPDATE byos_connections SET "accountLabel"='Claude Max', quota='{"plan":"Max"}' WHERE id=$1`, [connection]);
      const option = (await settings.botModels(alice))[0];
      assert.equal(option.accountLabel, 'Claude Max'); assert.equal(option.plan, 'Max');
      const refreshed = await settings.refreshBotModels(alice, connection, async (owner, id) => {
        assert.equal(owner, 'alice'); assert.equal(id, connection);
        return [{id:'provider-model'}, {id:'provider-model'}, {id:'second-provider-model'}];
      });
      assert.deepEqual(refreshed.map(row=>row.modelId).sort(), ['provider-model','second-provider-model']);
      await assert.rejects(settings.refreshBotModels(bob, connection, async () => { throw new Error('must not discover foreign account') }), { code: 'executionAccountUnavailable' });
      // A subscription belongs to the account: its owner refreshes it from any workspace (decision 2026-10-31-2130).
      await settings.refreshBotModels(other, connection, async () => []);
      await settings.refreshBotModels(alice, connection, async () => [{id:'fresh-only'}]);
      assert.deepEqual((await settings.botModels(alice)).map(row=>row.modelId),['fresh-only']);
      assert.equal(await settings.botModel(alice,secondBot),copiedBinding,'refresh preserves saved binding');
      await settings.refreshBotModels(alice, connection, async () => []);
      assert.deepEqual(await settings.botModels(alice),[],'empty provider catalogue remains authoritative');
      await settings.refreshBotModels(alice, connection, async () => [{id:'dynamic-model'}]);
      assert.equal((await (await import('./bot-model-menu')).botModelMenu(pool,settings,alice,secondBot)).current.id,(await settings.botModels(alice))[0].bindingId,'the picker maps the saved copy to its visible option');
      await assert.rejects(settings.refreshBotModels(alice, connection, async () => { throw new Error('raw provider response'); }), {code:'executionAccountUnavailable'});
      await assert.rejects(settings.refreshBotModels(alice, connection, async () => {
        await pool.query(`UPDATE byos_connections SET epoch=2 WHERE id=$1`,[connection]);
        return [{id:'stale-provider-model'}];
      }), {code:'executionAccountUnavailable'});
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM byos_bindings WHERE "modelId"='stale-provider-model'`)).rows[0].count,0);
      await pool.query(`UPDATE byos_connections SET epoch=1 WHERE id=$1`,[connection]);
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
      stub("./workspace-db.ts", { workspaceDb: drizzle(pool) });
      const actions = await import("../app/actions/execution-settings");
      const { freezeBotModel } = await import('./bot-model-selection');
      const { SubscriptionRepository } = await import('./subscription-repository');
      const dependencies = {service:()=>({repository:new SubscriptionRepository(pool)}) as never, workspace:async () => {}};
      const frozen = await freezeBotModel({ownerId:alice.ownerId,workspaceId:alice.workspaceId,botId:secondBot},dependencies);
      assert.equal((frozen.modelSelection as { bindingId?: string } | undefined)?.bindingId,copiedBinding,'execution uses its stored hidden binding after model list deduplication');
      const catalogue = (await settings.botModels(alice))[0];
      await settings.setBotModel(alice,null,catalogue.bindingId);
      const coordinator = await freezeBotModel({ownerId:alice.ownerId,workspaceId:alice.workspaceId,botId:null},dependencies);
      assert.equal(coordinator.modelSelection?.modelId,'dynamic-model','refreshed catalogue bindings support Coordinator execution');
      assert.equal((await (await import('./bot-model-menu')).botModelMenu(pool,settings,alice,secondBot)).current.id,catalogue.bindingId,'the picker shows the visible option for a saved copied binding');
      const { COORDINATOR_MODEL } = await import('./coordinator/model');
      const unbound = {ownerId:'bob',workspaceId:randomUUID(),botId:randomUUID()};
      await pool.query('INSERT INTO bots (id,"ownerId","workspaceId") VALUES ($1,$2,$3)',[unbound.botId,unbound.ownerId,unbound.workspaceId]);
      assert.deepEqual(await freezeBotModel(unbound,dependencies),{harness:'ai_sdk',model:COORDINATOR_MODEL},'a bot with no choice and no subscription runs on the hosted default');
      const revokedBot = randomUUID();
      await pool.query('INSERT INTO bots (id,"ownerId","workspaceId") VALUES ($1,$2,$3)',[revokedBot,alice.ownerId,alice.workspaceId]);
      await settings.setBotModel(alice,revokedBot,catalogue.bindingId);
      const { rows: [revoked] } = await pool.query('UPDATE byos_connections SET state=$2 WHERE id=(SELECT "connectionId" FROM byos_bindings WHERE id=$1) RETURNING id,state',[catalogue.bindingId,'disconnected']);
      const others = await pool.query(`UPDATE byos_connections SET state='disconnected' WHERE "ownerId"=$1 AND "workspaceId"=$2 AND state='connected' RETURNING id`,[alice.ownerId,alice.workspaceId]);
      assert.deepEqual(await freezeBotModel({ownerId:alice.ownerId,workspaceId:alice.workspaceId,botId:revokedBot},dependencies),{harness:'ai_sdk',model:COORDINATOR_MODEL},'a saved choice whose account was disconnected, with nothing else bound, replies on Mikka 默认');
      assert.deepEqual(await freezeBotModel({ownerId:alice.ownerId,workspaceId:alice.workspaceId,botId:null},dependencies),{harness:'ai_sdk',model:COORDINATOR_MODEL},'the Coordinator with no bound subscription replies on Mikka 默认');
      await pool.query(`UPDATE byos_connections SET state='connected' WHERE id=ANY($1::uuid[])`,[[revoked.id,...others.rows.map(row=>row.id)]]);

      // Decision 2026-11-01-2240: a subscription connected once, in alice's first workspace, runs her own bots in team B
      // with no share row and no switch; 分享给团队成员 and the admin switch decide only other members' use.
      const teamB = { ownerId: alice.ownerId, workspaceId: randomUUID() };
      const teamBot = randomUUID(), bobBot = randomUUID();
      await pool.query('INSERT INTO mikka_workspaces VALUES ($1)', [teamB.workspaceId]);
      await pool.query(`INSERT INTO mikka_workspace_members VALUES ($1,'alice','Alice','active'),($1,'bob','Bob','active')`, [teamB.workspaceId]);
      await pool.query('INSERT INTO bots (id,"ownerId","workspaceId") VALUES ($1,$2,$3),($4,$5,$3)',[teamBot,alice.ownerId,teamB.workspaceId,bobBot,'bob']);
      assert.equal((await pool.query('SELECT 1 FROM workspace_subscription_shares WHERE "ownerId"=$1 AND "workspaceId"=$2',[alice.ownerId,teamB.workspaceId])).rowCount,0,'nothing shared into team B');
      const inTeam = await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:teamBot},dependencies);
      assert.equal(inTeam.modelSelection?.workspaceId,teamB.workspaceId,'her own bot uses her subscription without sharing; the run and its binding belong to team B');
      assert.equal(inTeam.modelSelection?.consumerId,teamBot);
      assert.ok((await settings.botModels(teamB)).length > 0,'Bot 与 Agents in team B offers her own subscription without sharing');
      const teamMenu = await (await import('./bot-model-menu')).botModelMenu(pool,settings,teamB,null);
      assert.ok(teamMenu.groups.some(group => group.kind === 'subscription' && group.options.length > 0),'her Coordinator\'s model menu in team B lists her subscription, not only Mikka 默认');
      const { rows: [teamBinding] } = await pool.query('SELECT b."workspaceId",c."workspaceId" AS "connectionWorkspace" FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" WHERE b.id=$1',[(inTeam.modelSelection as { bindingId: string }).bindingId]);
      assert.deepEqual(teamBinding,{workspaceId:teamB.workspaceId,connectionWorkspace:alice.workspaceId},'the connection keeps the workspace it was made in; nothing is re-issued');
      const teamCoordinator = await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:null},dependencies);
      assert.equal(teamCoordinator.modelSelection?.workspaceId,teamB.workspaceId,'her Coordinator in team B uses her subscription too');
      // Unshared, it is hers alone.
      assert.equal((await settings.botModels({ownerId:'bob',workspaceId:teamB.workspaceId})).length,0,'another member of team B never sees or uses it');
      assert.deepEqual(await freezeBotModel({ownerId:'bob',workspaceId:teamB.workspaceId,botId:bobBot},dependencies),{harness:'ai_sdk',model:COORDINATOR_MODEL},'another member\'s bot replies on Mikka 默认');
      await assert.rejects(settings.bindingForBot({ownerId:'bob',workspaceId:teamB.workspaceId},null,catalogue.bindingId),{code:'executionModelUnknown'});
      await assert.rejects(settings.setBotModel({ownerId:'bob',workspaceId:teamB.workspaceId},bobBot,catalogue.bindingId),{code:'executionModelUnknown'});
      // Team B's admin turns off members' subscriptions: that limits sharing only, never her own use.
      await pool.query('INSERT INTO workspace_personal_policies ("workspaceId",subscriptions) VALUES ($1,false)',[teamB.workspaceId]);
      assert.ok((await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:teamBot},dependencies)).modelSelection,'admin switch off: her own bot still uses her subscription');
      assert.ok((await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:null},dependencies)).modelSelection,'admin switch off: her Coordinator too');
      assert.ok((await settings.botModels(teamB)).length > 0,'admin switch off: her menu still offers it');
      await pool.query('UPDATE workspace_personal_policies SET subscriptions=true WHERE "workspaceId"=$1',[teamB.workspaceId]);
      // A share row without 分享给团队成员 changes nothing for anyone; un-sharing never takes it from her.
      const { setSubscriptionShare } = await import('./personal-policy');
      await setSubscriptionShare(pool, alice.ownerId, teamB.workspaceId, true);
      assert.deepEqual(await freezeBotModel({ownerId:'bob',workspaceId:teamB.workspaceId,botId:bobBot},dependencies),{harness:'ai_sdk',model:COORDINATOR_MODEL},'shared without 分享给团队成员: bob\'s bot replies on Mikka 默认');
      await setSubscriptionShare(pool, alice.ownerId, teamB.workspaceId, false);
      assert.ok((await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:teamBot},dependencies)).modelSelection,'un-shared: her own bot still uses her subscription');
      // Alex 「B」: with 分享给团队成员, other members' bots may use her subscription too.
      await setSubscriptionShare(pool, alice.ownerId, teamB.workspaceId, true, true);
      const pooled = await freezeBotModel({ownerId:'bob',workspaceId:teamB.workspaceId,botId:bobBot},dependencies);
      assert.equal(pooled.modelSelection?.ownerId,alice.ownerId,'the subscription is hers');
      assert.equal((pooled.modelSelection as { runOwnerId?: string } | undefined)?.runOwnerId,'bob','the run is bob\'s');
      assert.equal(pooled.modelSelection?.consumerId,bobBot,'for bob\'s bot only');
      assert.equal(pooled.modelSelection?.workspaceId,teamB.workspaceId);
      assert.deepEqual(await freezeBotModel({ownerId:'bob',workspaceId:teamB.workspaceId,botId:null},dependencies),{harness:'ai_sdk',model:COORDINATOR_MODEL},'bob\'s Coordinator never uses another member\'s subscription');
      assert.equal((await settings.botModels({ownerId:'bob',workspaceId:teamB.workspaceId})).length,0,'bob is never offered her credential as his own choice');
      await assert.rejects(settings.bindingForOthersBot({ownerId:'bob',workspaceId:teamB.workspaceId},teamBot,alice.ownerId,catalogue.bindingId),{code:'executionModelUnknown'},'only for a bot of the run\'s own owner');
      // The admin block stops bob's use, not hers.
      await pool.query('UPDATE workspace_personal_policies SET subscriptions=false WHERE "workspaceId"=$1',[teamB.workspaceId]);
      assert.deepEqual(await freezeBotModel({ownerId:'bob',workspaceId:teamB.workspaceId,botId:bobBot},dependencies),{harness:'ai_sdk',model:COORDINATOR_MODEL},'blocked: bob\'s bot replies on Mikka 默认');
      await assert.rejects(settings.bindingForOthersBot({ownerId:'bob',workspaceId:teamB.workspaceId},bobBot,alice.ownerId,catalogue.bindingId),{code:'executionModelUnknown'});
      assert.ok((await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:teamBot},dependencies)).modelSelection,'blocked for others: hers still works');
      await pool.query('UPDATE workspace_personal_policies SET subscriptions=true WHERE "workspaceId"=$1',[teamB.workspaceId]);
      // Un-sharing takes it from everyone else at once; she keeps it.
      await setSubscriptionShare(pool, alice.ownerId, teamB.workspaceId, false);
      assert.deepEqual(await freezeBotModel({ownerId:'bob',workspaceId:teamB.workspaceId,botId:bobBot},dependencies),{harness:'ai_sdk',model:COORDINATOR_MODEL},'un-shared: bob\'s bot replies on Mikka 默认');
      assert.ok((await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:teamBot},dependencies)).modelSelection,'un-shared: hers still works');
      sessionOwner = null;
      await assert.rejects(actions.listBotModels());
      sessionOwner = "alice";
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
