// Real PostgreSQL: first task dispatch registers metadata without waking or
// inspecting a parent VM. No provider or model request is made by this suite.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { ensureBotCloudRuntime } from './auto-runtime'
import { ensureRecordedBotHarnessRuntime } from './bot-runtime-records'

const url = process.env.E2E_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'loopback only')
  assert.match(parsed.pathname, /^\/[a-z0-9_]+_e2e$/)
} else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs E2E_DATABASE_URL')

test('first task runtime is declared without a parent worker or VM and keeps ownership fences', { skip: !url, timeout: 120000 }, async () => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `task_runtime_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, database, 'template0')
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 4 })
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await pool.query(await readFile(new URL(file, dir), 'utf8'))
    const owner = 'first-task-owner', workspaceId = randomUUID()
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Fixture','first-task@example.invalid',true,now(),now())`, [owner])
    const actor = { userId: owner, workspaceId }
    const bot = async (label: string, workspace = workspaceId) => {
      const id = randomUUID()
      await pool.query('INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,$4)', [id, workspace, owner, label])
      return id
    }
    const firstBot = await bot('First Bot'), parentDevice = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,harnesses,"lastSeenAt")
      VALUES ($1,$2,'Existing sleeping parent','cloud',true,'[]',NULL)`, [parentDevice, owner])
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady")
      VALUES ($1,$2,$3,'untouched-parent',$4,'sleeping',true)`, [workspaceId, owner, randomUUID(), parentDevice])
    const parent = async () => (await pool.query(`SELECT row_to_json(m) AS machine,row_to_json(d) AS device
      FROM cloud_machines m JOIN devices d ON d.id=m."deviceId" WHERE m."workspaceId"=$1 AND m."ownerId"=$2`, [workspaceId, owner])).rows[0]
    const before = await parent()
    // This is the regression: the previous implementation returns null before
    // invoking its provider because the parent is sleeping.
    const first = await ensureBotCloudRuntime(pool, actor, firstBot, { harness: 'codex' })
    assert.ok(first, 'a first task must not require waking its sleeping parent')
    assert.deepEqual(await parent(), before, 'existing parent machine and device are byte-for-byte unchanged')
    const claude = await ensureBotCloudRuntime(pool, actor, firstBot, { harness: 'claude_code' })
    assert.ok(claude); assert.notEqual(claude.agentId, first.agentId)
    // Main's cross-Harness registration must use fresh task capabilities too.
    // Its default remains strict for callers using a prepared parent worker.
    assert.equal(await ensureRecordedBotHarnessRuntime(pool, actor, firstBot, 'codex'), null)
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      await tx.query('DELETE FROM bot_cloud_runtimes WHERE "botId"=$1 AND harness=$2', [firstBot, 'codex'])
      const recorded = await ensureRecordedBotHarnessRuntime(tx, actor, firstBot, 'codex', { freshTask: true })
      assert.equal(recorded?.agentId, first.agentId, 'a missing slot recovers only this exact hidden executor')
      assert.equal(await ensureRecordedBotHarnessRuntime(tx, { ...actor, userId: 'other-owner' }, firstBot, 'codex', { freshTask: true }), null)
      assert.equal(await ensureRecordedBotHarnessRuntime(tx, { ...actor, workspaceId: randomUUID() }, firstBot, 'codex', { freshTask: true }), null)
    } finally { await tx.query('ROLLBACK'); tx.release() }
    assert.deepEqual(await parent(), before, 'automatic task metadata never starts or installs on the parent')
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => ensureBotCloudRuntime(pool, actor, firstBot, { harness: 'codex' })))
    assert.ok(concurrent.every(runtime => runtime?.agentId === first.agentId), 'repeat registration keeps one exact identity')
    assert.equal(Number((await pool.query('SELECT count(*) FROM bot_cloud_runtimes WHERE "botId"=$1', [firstBot])).rows[0].count), 2)

    await pool.query(`UPDATE cloud_machines SET state='running' WHERE "workspaceId"=$1 AND "ownerId"=$2`, [workspaceId, owner])
    const runningBefore = await parent(), secondBot = await bot('Second Bot'), thirdBot = await bot('Third Bot')
    const created = await Promise.all([secondBot, thirdBot].map(botId => ensureBotCloudRuntime(pool, actor, botId, { harness: 'codex' })))
    assert.ok(created.every(Boolean))
    assert.deepEqual(await parent(), runningBefore, 'a running parent is unchanged too')
    const desktops = (await pool.query('SELECT display FROM bot_desktops WHERE "workspaceId"=$1 AND "ownerId"=$2 ORDER BY display', [workspaceId, owner])).rows
    assert.deepEqual(desktops.map(row => row.display), [1, 2, 3], 'concurrent new Bots reserve distinct displays')

    const deniedBot = await bot('Denied Bot')
    await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [parentDevice])
    const disabledBefore = await parent()
    assert.equal(await ensureBotCloudRuntime(pool, actor, deniedBot, { harness: 'codex' }), null)
    assert.deepEqual(await parent(), disabledBefore, 'disabled device is not re-enabled or replaced')
    assert.equal(Number((await pool.query('SELECT count(*) FROM bot_desktops WHERE "botId"=$1', [deniedBot])).rows[0].count), 0)
    await pool.query('UPDATE devices SET enabled=true WHERE id=$1', [parentDevice])
    const wrongWorkspace = randomUUID()
    assert.equal(await ensureBotCloudRuntime(pool, { ...actor, workspaceId: wrongWorkspace }, firstBot, { harness: 'codex' }), null)
    assert.equal(await ensureBotCloudRuntime(pool, { ...actor, userId: 'different-owner' }, firstBot, { harness: 'codex' }), null)
    await pool.query('UPDATE bots SET "archivedAt"=now() WHERE id=$1', [deniedBot])
    assert.equal(await ensureBotCloudRuntime(pool, actor, deniedBot, { harness: 'codex' }), null)
    assert.equal(await ensureBotCloudRuntime(pool, actor, firstBot, { harness: 'unsupported' }), null)

    // No parent computer has ever been started in this separate workspace.
    const newWorkspace = randomUUID(), newBot = await bot('No parent', newWorkspace)
    const fresh = await ensureBotCloudRuntime(pool, { ...actor, workspaceId: newWorkspace }, newBot, { harness: 'codex' })
    assert.ok(fresh)
    const declared = (await pool.query(`SELECT m.state,m."sandboxId",m."runtimeReady",d.enabled,d."lastSeenAt",d.harnesses
      FROM cloud_machines m JOIN devices d ON d.id=m."deviceId" WHERE m."workspaceId"=$1 AND m."ownerId"=$2`, [newWorkspace, owner])).rows[0]
    assert.deepEqual(declared, { state: 'sleeping', sandboxId: null, runtimeReady: false, enabled: true, lastSeenAt: null, harnesses: [] })
    assert.equal(Number((await pool.query('SELECT count(*) FROM device_tokens WHERE "userId"=$1', [owner])).rows[0].count), 0, 'metadata creates no worker credentials')
    const repos = (await pool.query(`SELECT repo."repoPath",repo."remoteUrl" FROM bot_cloud_runtimes r JOIN device_repos repo ON repo.id=r."repoId" WHERE r."botId"=$1`, [newBot])).rows
    assert.equal(repos.length, 2)
    assert.ok(repos.every(row => row.repoPath === `/home/user/.mikka/bot-workspaces/${newBot}` && row.remoteUrl === null))
    assert.equal(Number((await pool.query('SELECT count(*) FROM cloud_machines WHERE "workspaceId"=$1', [wrongWorkspace])).rows[0].count), 0, 'unauthorized workspace leaves no metadata')
  } finally {
    await dropTestDatabase(admin, database, pool)
    await admin.end()
  }
})
