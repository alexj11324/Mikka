/** Disposable E2B sandbox and isolated PostgreSQL schema; no real users. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { Sandbox } from 'e2b'
import { renewBotLifetime } from '../../lib/computer/bot-heartbeat'

async function main() {
  const database = process.env.COMPUTER_TEST_DATABASE_URL, template = process.env.E2B_COMPUTER_TEMPLATE
  if (!database || !template || !process.env.E2B_API_KEY) throw new Error('Disposable test configuration required')
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(database).hostname))
  const schema = `botbeat_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: database })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: database, options: `-c search_path=${schema}` })
  const options = { apiKey: process.env.E2B_API_KEY, proxy: process.env.HTTPS_PROXY, timeoutMs: 12_000 }
  let sandbox: Sandbox | undefined
  try {
    await pool.query(`CREATE TABLE cloud_machines ("workspaceId" uuid PRIMARY KEY,"ownerId" text,state text,"sandboxId" text,"lastActiveAt" timestamptz);
      CREATE TABLE bot_subagents ("workspaceId" uuid,"ownerId" text,state text,"stopRequestedAt" timestamptz)`)
    const actor = { userId: 'synthetic-owner', workspaceId: randomUUID() }
    sandbox = await Sandbox.create(template, { ...options, lifecycle: { onTimeout: 'pause', autoResume: false } })
    await pool.query(`INSERT INTO cloud_machines VALUES ($1,$2,'running',$3,now()-interval '5 minutes')`, [actor.workspaceId, actor.userId, sandbox.sandboxId])
    await pool.query(`INSERT INTO bot_subagents VALUES ($1,$2,'needs_you',NULL)`, [actor.workspaceId, actor.userId])
    assert.equal(await renewBotLifetime(pool, actor), true)
    await new Promise(resolve => setTimeout(resolve, 15_000))
    assert.equal((await Sandbox.getInfo(sandbox.sandboxId, options)).state, 'running')
    console.log('live Bot heartbeat: active task outlived the original timeout')
  } finally {
    if (sandbox) await sandbox.kill().catch(() => undefined)
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
}
void main().catch(error => { console.error('Bot heartbeat fixture failed:', error instanceof Error ? error.message : 'unknown'); process.exitCode = 1 })
