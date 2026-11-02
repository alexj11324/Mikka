import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'
import { SubscriptionRepository } from './subscription-repository'

const databaseURL = process.env.E2E_DATABASE_URL
const disposable = disposableDatabase(process.env, databaseURL)
if (process.env.REQUIRE_DB === '1' && !disposable) throw new Error('Subscription selection tests require an isolated local database')

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
