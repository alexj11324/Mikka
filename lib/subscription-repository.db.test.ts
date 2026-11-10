import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'
import { SubscriptionRepository } from './subscription-repository'

const databaseURL = process.env.E2E_DATABASE_URL
const disposable = disposableDatabase(process.env, databaseURL)
if (process.env.REQUIRE_DB === '1' && !disposable) throw new Error('Subscription selection tests require an isolated local database')

test('native binding admits its Owner, rejects legacy borrowing, and rechecks exact authority after discovery', { skip: !disposable }, async t => {
  const admin = new Pool({ connectionString: databaseURL })
  const schema = `native_binding_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  const workspaceId = randomUUID(), agentId = randomUUID(), connectionId = randomUUID(), bindingId = randomUUID(), olderId = randomUUID()
  try {
    await pool.query(`CREATE TABLE agents (id uuid PRIMARY KEY,"userId" text);
      CREATE TABLE byos_connections (id uuid PRIMARY KEY,"ownerId" text,provider text,state text,epoch bigint,paused boolean);
      CREATE TABLE byos_bindings (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,"consumerId" text,"connectionId" uuid,"connectionRevision" bigint,route text,"modelId" text,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE workspace_subscription_shares ("ownerId" text,"workspaceId" uuid,"allowOthers" boolean);
      CREATE TABLE workspace_personal_policies ("workspaceId" uuid,subscriptions boolean)`)
    await pool.query(`INSERT INTO agents VALUES ($1,'requester')`, [agentId])
    await pool.query(`INSERT INTO byos_connections VALUES ($1,'requester','codex','connected',7,false)`, [connectionId])
    const reset = async () => {
      await pool.query(`UPDATE agents SET "userId"='requester'; UPDATE byos_connections SET "ownerId"='requester',state='connected',paused=false,epoch=7;
        DELETE FROM workspace_subscription_shares; DELETE FROM workspace_personal_policies; DELETE FROM byos_bindings`)
      // Deliberately model an old schema with historical true grants. Current
      // application authorization must deny them even before migration runs.
      await pool.query(`INSERT INTO workspace_subscription_shares VALUES ('payor',$1,true)`, [workspaceId])
      await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId","createdAt")
        VALUES ($1,'requester',$2,$3,$4,7,'codex_cli','fixture-model',now()),($5,'requester',$2,$3,$4,8,'codex_cli','older-model',now()-interval '1 day')`,
      [bindingId, workspaceId, agentId, connectionId, olderId])
    }
    let reads = 0, afterDiscovery: (() => Promise<void>) | undefined
    const query = (async (sql: string, params?: unknown[]) => {
      reads++
      const result = await pool.query(sql, params)
      if (reads === 1) await afterDiscovery?.()
      return result
    }) as Pool['query']
    const { nativeRunBinding } = await import('./computer/native-run-binding')
    await reset()
    assert.equal((await nativeRunBinding({ query }, 'requester', agentId, 'codex', workspaceId))?.id, bindingId)
    assert.equal(reads, 2)
    await pool.query(`UPDATE byos_connections SET "ownerId"='payor'; UPDATE byos_bindings SET "ownerId"='payor'`)
    reads = 0
    assert.equal(await nativeRunBinding({ query }, 'requester', agentId, 'codex', workspaceId), null)
    assert.equal(reads, 1, 'no foreign connection or credential is loaded')
    const mutations = {
      agent: `UPDATE agents SET "userId"='foreign-owner'`,
      scope: `UPDATE byos_bindings SET "workspaceId"='${randomUUID()}' WHERE id='${bindingId}'`,
      owner: `UPDATE byos_bindings SET "ownerId"='payor' WHERE id='${bindingId}'`,
      pause: 'UPDATE byos_connections SET paused=true',
      epoch: 'UPDATE byos_connections SET epoch=8',
      deleted: `DELETE FROM byos_bindings WHERE id='${bindingId}'`,
    }
    for (const [kind, sql] of Object.entries(mutations)) await t.test(`refuses ${kind} changed after discovery without falling back to the older binding`, async () => {
      await reset(); reads = 0
      afterDiscovery = async () => { await pool.query(sql) }
      assert.equal(await nativeRunBinding({ query }, 'requester', agentId, 'codex', workspaceId), null)
      assert.equal(reads, 2)
    })
    afterDiscovery = undefined
    await reset()
    await pool.query(`DELETE FROM workspace_subscription_shares`)
    await pool.query(`INSERT INTO workspace_personal_policies VALUES ($1,false)`, [workspaceId])
    assert.equal((await nativeRunBinding(pool, 'requester', agentId, 'codex', workspaceId))?.id, bindingId, 'legacy teammate policy cannot take away the Owner personal subscription')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})

test('a frozen binding and its owner-scoped connection use one fresh query without custody fields', { skip: !disposable }, async () => {
  const admin = new Pool({ connectionString: databaseURL })
  const schema = `subscription_authority_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE byos_connections (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,provider text,state text,epoch bigint,quota jsonb,"accountLabel" text,paused boolean,"custodyAccessRef" text);
      CREATE TABLE byos_bindings (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,"consumerId" text,"connectionId" uuid,"connectionRevision" bigint,route text,"modelId" text)`)
    const workspace = randomUUID(), custodyWorkspace = randomUUID(), consumer = randomUUID(), bindingId = randomUUID(), connectionId = randomUUID()
    await pool.query(`INSERT INTO byos_connections VALUES ($1,'alice',$2,'claude','connected',7,'{}','Fixture',false,'private-fixture-reference')`, [connectionId, custodyWorkspace])
    await pool.query(`INSERT INTO byos_bindings VALUES ($1,'alice',$2,$3,$4,7,'claude_cpa','fixture-model')`, [bindingId, workspace, consumer, connectionId])
    let reads = 0
    const query = ((text: string, values?: unknown[]) => { reads++; return pool.query(text, values) }) as Pool['query']
    const repository = new SubscriptionRepository({ query })
    const first = await repository.bindingConnection('alice', bindingId)
    assert.equal(reads, 1)
    assert.deepEqual(first.binding, { id: bindingId, ownerId: 'alice', workspaceId: workspace, consumerId: consumer, connectionId, connectionRevision: 7, route: 'claude_cpa', modelId: 'fixture-model' })
    assert.deepEqual(first.connection, { id: connectionId, ownerId: 'alice', workspaceId: custodyWorkspace, provider: 'claude', state: 'connected', epoch: '7', quota: {}, accountLabel: 'Fixture', paused: false })

    await pool.query(`UPDATE byos_connections SET state='disconnected',epoch=8,paused=true WHERE id=$1`, [connectionId])
    const revoked = await repository.bindingConnection('alice', bindingId)
    assert.equal(reads, 2)
    assert.equal(revoked.connection?.state, 'disconnected')
    assert.equal(revoked.connection?.epoch, '8')
    assert.equal(revoked.connection?.paused, true)
    assert.equal(revoked.binding.connectionRevision, 7)

    await pool.query(`UPDATE byos_connections SET "ownerId"='bob' WHERE id=$1`, [connectionId])
    assert.deepEqual(await repository.bindingConnection('alice', bindingId), { binding: first.binding, connection: null }, 'a foreign connection is not exposed through an owned binding')
    await assert.rejects(repository.bindingConnection('bob', bindingId), { code: 'binding_required' })
    await assert.rejects(repository.bindingConnection('alice', randomUUID()), { code: 'binding_required' })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})

test('concurrent Connect reserves one bounded owner/workspace/provider acquisition', { skip: !disposable }, async () => {
  const admin = new Pool({ connectionString: databaseURL })
  const schema = `subscription_acquire_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE byos_connections (id uuid PRIMARY KEY,"ownerId" text NOT NULL,"workspaceId" text NOT NULL,provider text NOT NULL,state text NOT NULL,epoch bigint DEFAULT 1,"operationId" uuid,"operationKind" text,"operationDeadline" timestamptz,"removedAt" timestamptz,"createdAt" timestamptz DEFAULT now(),CHECK (("operationId" IS NULL)=("operationKind" IS NULL)),CHECK (("operationId" IS NULL)=("operationDeadline" IS NULL)))`)
    await pool.query(`CREATE TABLE byos_enrollment_transfers ("connectionId" uuid PRIMARY KEY,epoch bigint NOT NULL,"operationId" uuid NOT NULL)`)
    const repo = new SubscriptionRepository(pool), workspace = randomUUID()
    const starts = await Promise.all(Array.from({ length: 6 }, () => repo.acquire('alice', workspace, 'codex')))
    assert.equal(new Set(starts.map(start => start.connectionId)).size, 1)
    assert.equal(starts.filter(start => start.created).length, 1)
    const { rows: [reserved] } = await pool.query(`SELECT state,"operationKind","operationId",epoch,"operationDeadline">now() AND "operationDeadline"<=now()+interval '5 minutes' AS bounded FROM byos_connections WHERE id=$1`, [starts[0].connectionId])
    assert.equal(reserved.state, 'pending')
    assert.equal(reserved.operationKind, 'acquire')
    assert.ok(reserved.operationId)
    assert.equal(reserved.epoch, '1')
    assert.equal(reserved.bounded, true)
    for (const other of [await repo.acquire('bob', workspace, 'codex'), await repo.acquire('alice', randomUUID(), 'codex'), await repo.acquire('alice', workspace, 'claude')]) assert.notEqual(other.connectionId, starts[0].connectionId)
    await pool.query(`UPDATE byos_connections SET "operationDeadline"=now()-interval '1 second' WHERE id=$1`, [starts[0].connectionId])
    assert.notEqual((await repo.acquire('alice', workspace, 'codex')).connectionId, starts[0].connectionId)
    const enrollment = await repo.acquire('alice', workspace, 'codex')
    await pool.query(`INSERT INTO byos_enrollment_transfers SELECT id,epoch,"operationId" FROM byos_connections WHERE id=$1`, [enrollment.connectionId])
    const before = (await pool.query('SELECT * FROM byos_connections WHERE id=$1', [enrollment.connectionId])).rows
    assert.notEqual((await repo.acquire('alice', workspace, 'codex')).connectionId, enrollment.connectionId, 'web sign-in does not take over a recoverable desktop enrollment')
    assert.deepEqual((await pool.query('SELECT * FROM byos_connections WHERE id=$1', [enrollment.connectionId])).rows, before)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})

test('subscription selections are current saved chats in the authorized workspace, never binding history', { skip: !disposable }, async () => {
  const admin = new Pool({ connectionString: databaseURL })
  const schema = `subscription_selections_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,name text,color text DEFAULT 'encre',shape text DEFAULT 'cercle',"archivedAt" timestamptz);
      CREATE TABLE coordinator_bots ("ownerId" text,"workspaceId" uuid,"botId" uuid,PRIMARY KEY ("ownerId","workspaceId"));
      CREATE TABLE byos_connections (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,epoch bigint DEFAULT 1,state text DEFAULT 'connected',paused boolean DEFAULT false,"removedAt" timestamptz);
      CREATE TABLE byos_bindings (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,"consumerId" text,"connectionId" uuid,"connectionRevision" bigint DEFAULT 1,route text DEFAULT 'claude_cpa',"createdAt" timestamptz DEFAULT now());
      CREATE TABLE bot_model_choices ("ownerId" text,"workspaceId" uuid,"botKey" text,"bindingId" uuid,"apiKeyId" uuid,PRIMARY KEY ("ownerId","workspaceId","botKey"));
      CREATE TABLE bot_cloud_runtimes ("agentId" uuid,"botId" uuid,"ownerId" text,"workspaceId" uuid)`)
    const repository = new SubscriptionRepository(pool)
    const workspace = randomUUID(), elsewhere = randomUUID()
    const bot = randomUUID(), otherCoordinator = randomUUID(), bobBot = randomUUID(), archived = randomUUID()
    const oldConnection = randomUUID(), selectedConnection = randomUUID(), bobsConnection = randomUUID()
    const oldBinding = randomUUID(), currentBinding = randomUUID(), elsewhereBinding = randomUUID(), bobBinding = randomUUID(), foreignBinding = randomUUID(), archivedBinding = randomUUID()
    await pool.query(`INSERT INTO bots (id,"ownerId","workspaceId",name,"archivedAt") VALUES
      ($1,'alice',$5,'Coordinator',NULL),($2,'alice',$6,'Coordinator',NULL),($3,'bob',$5,'Private teammate bot',NULL),($4,'alice',$5,'Archived bot',now())`, [bot, otherCoordinator, bobBot, archived, workspace, elsewhere])
    // An account's subscription can have been connected in a different workspace.
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId") VALUES ($1,'alice',$4),($2,'alice',$5),($3,'bob',$4)`, [oldConnection, selectedConnection, bobsConnection, workspace, elsewhere])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId",route) VALUES
      ($1,'alice',$7,$9,$13,'claude_cpa'),($2,'alice',$7,$9,$14,'codex_cpa'),($3,'alice',$8,$10,$14,'claude_cpa'),
      ($4,'alice',$7,$11,$14,'claude_cpa'),($5,'bob',$7,$9,$15,'claude_cpa'),($6,'alice',$7,$12,$14,'claude_cpa')`,
    [oldBinding, currentBinding, elsewhereBinding, bobBinding, foreignBinding, archivedBinding, workspace, elsewhere, bot, otherCoordinator, bobBot, archived, oldConnection, selectedConnection, bobsConnection])
    assert.deepEqual(await repository.connectionBots('alice', workspace), [], 'past bot bindings are not saved chat choices')

    await pool.query(`INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId") VALUES
      ('alice',$1,$3,$5),('alice',$2,$4,$6),('bob',$1,$7,$8),('alice',$1,$9,$10)`,
    [workspace, elsewhere, bot, otherCoordinator, currentBinding, elsewhereBinding, bobBot, bobBinding, archived, archivedBinding])
    const selected = { connectionId: selectedConnection, id: bot, name: 'Coordinator', color: 'encre', shape: 'cercle', workspaceId: workspace }
    assert.deepEqual(await repository.connectionBots('alice', workspace), [selected], 'one current workspace Coordinator, without another member or archived bots')
    assert.deepEqual(await repository.connectionBots('alice', elsewhere), [{ ...selected, id: otherCoordinator, workspaceId: elsewhere }])

    // These are selections, not active runs: pausing or reconnecting does not erase a saved pick.
    await pool.query(`UPDATE byos_connections SET paused=true,epoch=2 WHERE id=$1`, [selectedConnection])
    assert.deepEqual(await repository.connectionBots('alice', workspace), [selected])

    await pool.query(`UPDATE bot_model_choices SET "bindingId"=NULL WHERE "ownerId"='alice' AND "workspaceId"=$1 AND "botKey"=$2`, [workspace, bot])
    assert.deepEqual(await repository.connectionBots('alice', workspace), [], 'choosing Mikka default clears the subscription selection')
    await pool.query(`UPDATE bot_model_choices SET "apiKeyId"=$3 WHERE "ownerId"='alice' AND "workspaceId"=$1 AND "botKey"=$2`, [workspace, bot, randomUUID()])
    assert.deepEqual(await repository.connectionBots('alice', workspace), [], 'choosing an API key does not revive old subscription bindings')
    await pool.query(`UPDATE bot_model_choices SET "bindingId"=$3,"apiKeyId"=NULL WHERE "ownerId"='alice' AND "workspaceId"=$1 AND "botKey"=$2`, [workspace, bot, foreignBinding])
    assert.deepEqual(await repository.connectionBots('alice', workspace), [], 'a saved foreign-owner binding never exposes another account')

    await pool.query(`DELETE FROM bot_model_choices WHERE "ownerId"='alice' AND "workspaceId"=$1 AND "botKey"=$2`, [workspace, bot])
    await pool.query(`INSERT INTO coordinator_bots VALUES ('alice',$1,$2)`, [workspace, bot])
    await pool.query(`INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId") VALUES ('alice',$1,'coordinator',$2)`, [workspace, currentBinding])
    assert.deepEqual(await repository.connectionBots('alice', workspace), [selected], 'legacy Coordinator choice resolves to the same scoped bot')
    await pool.query(`INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId") VALUES ('alice',$1,$2,NULL)`, [workspace, bot])
    assert.deepEqual(await repository.connectionBots('alice', workspace), [], 'the bot-id choice supersedes the legacy Coordinator sentinel')
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
