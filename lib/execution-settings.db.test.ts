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
      CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,kind text,"removedAt" timestamptz,"lastSeenAt" timestamptz,enabled boolean,"deviceType" text,name text,harnesses jsonb,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,"archivedAt" timestamptz);
      CREATE TABLE byos_connections (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,epoch bigint,state text,provider text,"accountLabel" text,quota jsonb,"removedAt" timestamptz);
      CREATE TABLE byos_bindings (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,"consumerId" text,"connectionId" uuid,"connectionRevision" bigint,"modelId" text,route text,"createdAt" timestamptz DEFAULT now())`);
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
      const catalogueMigration = await readFile(new URL('../drizzle/20261030233002_byos_model_catalog.sql',import.meta.url),'utf8');
      await pool.query(catalogueMigration); await pool.query(catalogueMigration);
      const personalPolicyMigration = await readFile(new URL("../drizzle/20261031213105_workspace_personal_policies.sql",import.meta.url),"utf8");
      await pool.query(personalPolicyMigration); await pool.query(personalPolicyMigration);
      const explicitMigration = await readFile(new URL("../drizzle/20261031054017_explicit_execution.sql",import.meta.url),"utf8");
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
        `INSERT INTO devices (id,"ownerId",kind,enabled,"lastSeenAt",harnesses) VALUES ($1,'alice','local',true,now(),'[{"harness":"codex","installed":true,"models":["explicit-model"],"defaultModelSlot":"default","modelSlots":[{"slot":"default","model":"explicit-model","name":"Explicit model"}]}]'),($2,'bob','local',true,now(),'[]')`,
        [own, foreign],
      );
      const legacyId = randomUUID();
      await pool.query(
        `INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,'alice',$2,'legacy','auto','auto','auto',0)`,
        [legacyId, alice.workspaceId],
      );
      await pool.query(explicitMigration);
      await pool.query(explicitMigration);
      assert.equal((await pool.query('SELECT model FROM execution_rules WHERE id=$1',[legacyId])).rows[0].model,'default');
      const migrated = await settings.list(alice);
      assert.equal(
        migrated.find((r) => r.id === legacyId)?.model,
        "default",
      );
      assert.equal(migrated.find((r) => r.id === legacyId)?.place, own);
      await settings.mutate(alice, { kind: "delete", id: legacyId });
      const value = {
        label: "backend",
        place: own,
        harness: "codex" as const,
        model: "explicit-model",
      };
      assert.deepEqual(
        (await settings.list(alice)).map((r) => r.id),
        ["default"],
      );
      await settings.mutate(alice, { kind: "save", value });
      await settings.mutate(alice, {
        kind: "save",
        value: { ...value, label: "frontend" },
      });
      await pool.query('DELETE FROM execution_rules WHERE label IS NULL AND "ownerId"=$1 AND "workspaceId"=$2',[alice.ownerId,alice.workspaceId]);
      await Promise.all(Array.from({ length: 12 }, () => settings.list(alice)));
      await settings.mutate(alice, {
        kind: "save",
        id: "default",
        value: { ...value, model: "explicit-model" },
      });
      assert.equal(
        (await settings.list(alice)).find((r) => r.id === "default")?.place,
        own,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM execution_rules WHERE label IS NULL AND "ownerId"=$1 AND "workspaceId"=$2',
            [alice.ownerId, alice.workspaceId],
          )
        ).rows[0].n,
        1,
      );
      assert.deepEqual(await settings.fallbacks("alice"), {
        whenDeviceOffline: "wait",
        whenQuotaExhausted: "stop",
      });
      await settings.setFallbacks("alice", {
        whenDeviceOffline: "cloud",
        whenQuotaExhausted: "switchAccount",
      });
      assert.equal(
        (await settings.fallbacks("alice")).whenDeviceOffline,
        "cloud",
      );
      for (const field of ["place", "harness", "model"])
        await assert.rejects(
          settings.mutate(alice, {
            kind: "save",
            value: { ...value, [field]: "auto" },
          }),
          { code: "executionAutoNotAllowed" },
        );
      const rules = await settings.list(alice),
        ids = rules.filter((r) => r.label !== null).map((r) => r.id);
      await assert.rejects(settings.list(bob),{code:"executionModelUnknown"});
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
      const receipt = await settings.redetect(alice, own);
      assert.equal((await settings.redetectStatus(alice, receipt.commandId)).status, 'pending');
      await assert.rejects(settings.redetectStatus(bob, receipt.commandId), { code: 'executionCommandNotFound' });
      await pool.query('UPDATE device_management_commands SET "completedAt"=now() WHERE id=$1', [receipt.commandId]);
      assert.equal((await settings.redetectStatus(alice, receipt.commandId)).status, 'completed');
      await pool.query('UPDATE device_management_commands SET error=$2 WHERE id=$1', [receipt.commandId, 'detection_failed']);
      assert.equal((await settings.redetectStatus(alice, receipt.commandId)).status, 'failed');
      assert.ok(
        (
          await pool.query(
            'SELECT id FROM device_management_commands WHERE "deviceId"=$1',
            [own],
          )
        ).rows[0].id,
      );
      await pool.query('UPDATE devices SET "removedAt"=now() WHERE id=$1', [
        own,
      ]);
      await assert.rejects(settings.redetect(alice, own));
      assert.equal(
        (await settings.places(alice)).some((place) => place.id === own),
        false,
      );
      await assert.rejects(settings.mutate(alice, { kind: "save", value }));
      await pool.query('UPDATE devices SET "removedAt"=NULL WHERE id=$1', [
        own,
      ]);
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
      const server = randomUUID(),claudeConnection=randomUUID(),claudeBinding=randomUUID();
      await pool.query(`INSERT INTO devices (id,"ownerId",kind,enabled,"lastSeenAt","deviceType",harnesses) VALUES ($1,'alice','local',true,now(),'server',$2)`,[server,JSON.stringify([{harness:'claude_code',installed:true,models:['opus'],defaultModelSlot:'opus',modelSlots:[{slot:'opus',model:'reported-opus',name:'Reported opus'}]}])]);
      await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",epoch,state,provider) VALUES ($1,'alice',$2,1,'connected','claude')`,[claudeConnection,alice.workspaceId]);
      await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision","modelId",route) VALUES ($1,'alice',$2,$3,$4,1,'reported-opus','claude_cpa')`,[claudeBinding,alice.workspaceId,bot,claudeConnection]);
      assert.deepEqual(await settings.suggested(alice),{id:'default',label:null,place:server,harness:'claude_code',model:'opus',position:2147483647});
      await pool.query(`UPDATE byos_connections SET state='disconnected' WHERE id=$1`,[claudeConnection]);
      assert.equal((await settings.suggested(alice)).harness,'codex');
      assert.equal((await settings.suggested(alice)).model,'default');
      await pool.query('DELETE FROM devices WHERE id=$1',[server]);

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
      assert.equal(await settings.botModelOption(alice,secondBot),(await settings.botModels(alice))[0].bindingId,'UI selection maps the saved copy to its visible option');
      await assert.rejects(settings.refreshBotModels(alice, connection, async () => { throw new Error('raw provider response'); }), {code:'executionAccountUnavailable'});
      await assert.rejects(settings.refreshBotModels(alice, connection, async () => {
        await pool.query(`UPDATE byos_connections SET epoch=2 WHERE id=$1`,[connection]);
        return [{id:'stale-provider-model'}];
      }), {code:'executionAccountUnavailable'});
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM byos_bindings WHERE "modelId"='stale-provider-model'`)).rows[0].count,0);
      await pool.query(`UPDATE byos_connections SET epoch=1 WHERE id=$1`,[connection]);
      const ruleValue = {label:'typed', place:own,harness:'codex' as const,model:'explicit-model'};
      for (const [patch,code] of [[{place:'invalid'},'executionPlaceInvalid'],[{harness:'missing'},'executionHarnessUnavailable'],[{harness:'mock'},'executionHarnessUnavailable'],[{model:'missing'},'executionModelUnknown']] as const) {
        await assert.rejects(settings.mutate(alice, {kind:'save',value:{...ruleValue,...patch} as typeof ruleValue}), {code});
      }
      await assert.rejects(settings.mutate(alice,{kind:'delete',id:randomUUID()}), {code:'executionRuleNotFound'});
      const fixtureScope = {...alice,workspaceId:randomUUID()};
      await pool.query(`INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,$2,$3,NULL,$4,'mock','fixture-model',2147483647)`,[randomUUID(),alice.ownerId,fixtureScope.workspaceId,own]);
      const fixtureRules = await settings.list(fixtureScope);
      const {resolveExecution}=await import('./execution-rules');
      assert.deepEqual(resolveExecution([],fixtureRules,[{id:own,enabled:true,online:true,harnesses:[{harness:'mock',installed:true,version:null}]}]),{place:own,harness:'mock',model:'fixture-model'});
      const labelled = randomUUID(), otherLabelled = randomUUID(), deletedLabelled = randomUUID(), personalLabelled = randomUUID();
      await pool.query('CREATE TABLE issues (id uuid PRIMARY KEY,content jsonb,scope text,"updatedAt" timestamptz DEFAULT now())');
      const labelledContent = (name: string, deletedAt: string | null = null) => ({type:'doc',attrs:{mikka:{labels:[{name,color:'blue'}],deletedAt}}});
      for (const [id,name,kind,deletedAt] of [[labelled,'backend','workspace',null],[otherLabelled,'foreign','workspace',null],[deletedLabelled,'deleted','workspace',new Date().toISOString()],[personalLabelled,'private','personal',null]]) {
        await pool.query('INSERT INTO issues (id,content,scope) VALUES ($1,$2,$3)', [id,JSON.stringify(labelledContent(name!,deletedAt)),kind]);
      }
      mock.module(new URL('./issue-team-access.ts',import.meta.url).href,{namedExports:{issueTeamScope:async () => [
        {issueId:labelled,workspaceId:alice.workspaceId},{issueId:otherLabelled,workspaceId:other.workspaceId},
        {issueId:deletedLabelled,workspaceId:alice.workspaceId},{issueId:personalLabelled,workspaceId:alice.workspaceId}
      ]}});
      assert.deepEqual(await settings.labels(alice), [{name:'backend',color:'blue'}]);
      assert.deepEqual(await settings.labels(other), [{name:'foreign',color:'blue'}]);
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
      const { freezeBotModel } = await import('./bot-model-selection');
      const { SubscriptionRepository } = await import('./subscription-repository');
      const dependencies = {service:()=>({repository:new SubscriptionRepository(pool)}) as never, workspace:async () => {}};
      const frozen = await freezeBotModel({ownerId:alice.ownerId,workspaceId:alice.workspaceId,botId:secondBot},dependencies);
      assert.equal(frozen.modelSelection?.bindingId,copiedBinding,'execution uses its stored hidden binding after model list deduplication');
      const catalogue = (await settings.botModels(alice))[0];
      await settings.setBotModel(alice,null,catalogue.bindingId);
      const coordinator = await freezeBotModel({ownerId:alice.ownerId,workspaceId:alice.workspaceId,botId:null},dependencies);
      assert.equal(coordinator.modelSelection?.modelId,'dynamic-model','refreshed catalogue bindings support Coordinator execution');
      assert.equal(await actions.getBotModel(secondBot),catalogue.bindingId,'action returns the visible option for a saved copied binding');
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

      // Decision 2026-10-31-2330: a subscription connected once, in alice's first workspace, runs her Bot in team B only after she shares it there.
      const teamB = { ownerId: alice.ownerId, workspaceId: randomUUID() };
      const teamBot = randomUUID(), bobBot = randomUUID();
      await pool.query('INSERT INTO bots (id,"ownerId","workspaceId") VALUES ($1,$2,$3),($4,$5,$3)',[teamBot,alice.ownerId,teamB.workspaceId,bobBot,'bob']);
      assert.deepEqual(await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:teamBot},dependencies),{harness:'ai_sdk',model:COORDINATOR_MODEL},'not shared yet: Mikka 默认');
      assert.deepEqual(await settings.botModels(teamB),[],'not shared yet: Bot 与 Agents in team B offers no personal subscription');
      const { setSubscriptionShare } = await import('./personal-policy');
      await setSubscriptionShare(pool, alice.ownerId, teamB.workspaceId, true);
      const inTeam = await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:teamBot},dependencies);
      assert.equal(inTeam.modelSelection?.workspaceId,teamB.workspaceId,'the run and its binding belong to team B');
      assert.equal(inTeam.modelSelection?.consumerId,teamBot);
      const { rows: [teamBinding] } = await pool.query('SELECT b."workspaceId",c."workspaceId" AS "connectionWorkspace" FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" WHERE b.id=$1',[inTeam.modelSelection!.bindingId]);
      assert.deepEqual(teamBinding,{workspaceId:teamB.workspaceId,connectionWorkspace:alice.workspaceId},'the connection keeps the workspace it was made in; nothing is re-issued');
      const teamCoordinator = await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:null},dependencies);
      assert.equal(teamCoordinator.modelSelection?.workspaceId,teamB.workspaceId,'her Coordinator in team B uses her shared subscription too');
      // Shared means for her own bots only.
      assert.equal((await settings.botModels({ownerId:'bob',workspaceId:teamB.workspaceId})).length,0,'another member of team B never sees or uses it');
      assert.deepEqual(await freezeBotModel({ownerId:'bob',workspaceId:teamB.workspaceId,botId:bobBot},dependencies),{harness:'ai_sdk',model:COORDINATOR_MODEL},'another member\'s bot replies on Mikka 默认');
      await assert.rejects(settings.bindingForBot({ownerId:'bob',workspaceId:teamB.workspaceId},null,catalogue.bindingId),{code:'executionModelUnknown'});
      await assert.rejects(settings.setBotModel({ownerId:'bob',workspaceId:teamB.workspaceId},bobBot,catalogue.bindingId),{code:'executionModelUnknown'});
      // Team B's admin blocks members' subscriptions: her Bot and Coordinator reply on Mikka 默认.
      await pool.query('INSERT INTO workspace_personal_policies ("workspaceId",subscriptions) VALUES ($1,false)',[teamB.workspaceId]);
      assert.deepEqual(await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:teamBot},dependencies),{harness:'ai_sdk',model:COORDINATOR_MODEL},'blocked: Mikka 默认, not her subscription');
      assert.deepEqual(await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:null},dependencies),{harness:'ai_sdk',model:COORDINATOR_MODEL});
      assert.deepEqual(await settings.botModels(teamB),[]);
      assert.ok((await freezeBotModel({ownerId:alice.ownerId,workspaceId:alice.workspaceId,botId:null},dependencies)).modelSelection,'the block is per workspace');
      await pool.query('UPDATE workspace_personal_policies SET subscriptions=true WHERE "workspaceId"=$1',[teamB.workspaceId]);
      assert.ok((await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:teamBot},dependencies)).modelSelection,'unblocked: her shared subscription');
      // Un-sharing takes it out of team B at once.
      await setSubscriptionShare(pool, alice.ownerId, teamB.workspaceId, false);
      assert.deepEqual(await freezeBotModel({ownerId:alice.ownerId,workspaceId:teamB.workspaceId,botId:teamBot},dependencies),{harness:'ai_sdk',model:COORDINATOR_MODEL},'un-shared: Mikka 默认');
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
