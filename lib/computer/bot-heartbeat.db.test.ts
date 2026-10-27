import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { renewBotLifetime } from './bot-heartbeat'

const databaseURL = process.env.COMPUTER_TEST_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Computer database test URL required')

test('only active owned web tasks extend a Bot machine, and failures retry', { skip: !databaseURL }, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(databaseURL!).hostname))
  const schema = `botbeat_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseURL }); await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  const actor = { userId: 'alice', workspaceId: randomUUID() }
  const calls: string[] = []
  const renew = async (id: string) => { calls.push(id) }
  try {
    await pool.query(`CREATE TABLE cloud_machines ("workspaceId" uuid PRIMARY KEY,"ownerId" text,state text,"sandboxId" text,"lastActiveAt" timestamptz);
      CREATE TABLE bot_subagents ("workspaceId" uuid,"ownerId" text,state text,"stopRequestedAt" timestamptz)`)
    await pool.query(`INSERT INTO cloud_machines VALUES ($1,$2,'running','machine',now()-interval '5 minutes')`, [actor.workspaceId, actor.userId])
    await pool.query(`INSERT INTO bot_subagents VALUES ($1,$2,'queued',NULL)`, [actor.workspaceId, actor.userId])
    assert.equal(await renewBotLifetime(pool, actor, renew), false)
    await pool.query(`UPDATE bot_subagents SET state='needs_you'`)
    assert.equal(await renewBotLifetime(pool, { ...actor, userId: 'bob' }, renew), false)
    await assert.rejects(renewBotLifetime(pool, actor, async () => { throw new Error('temporary failure') }), /temporary failure/)
    assert.equal(await renewBotLifetime(pool, actor, renew), true)
    assert.deepEqual(calls, ['machine'])
    assert.equal(await renewBotLifetime(pool, actor, renew), false)
    await pool.query(`UPDATE cloud_machines SET "lastActiveAt"=now()-interval '5 minutes'`)
    await pool.query(`UPDATE bot_subagents SET "stopRequestedAt"=now()`)
    assert.equal(await renewBotLifetime(pool, actor, renew), false)
    await pool.query(`UPDATE bot_subagents SET "stopRequestedAt"=NULL; UPDATE cloud_machines SET state='paused'`)
    assert.equal(await renewBotLifetime(pool, actor, renew), false)
    await pool.query(`UPDATE cloud_machines SET state='running'`)
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => renewBotLifetime(pool, actor, renew)))
    assert.equal(concurrent.filter(Boolean).length, 1)
    assert.deepEqual(calls, ['machine', 'machine'])
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() }
})
