// A bot keeps its hidden Claude/Codex runtime when its computer's device changes
// or a device removal unbinds the agent (lib/device-removal.ts): the next wake
// moves the runtime to the machine's device instead of failing on the agent's
// unique name (production, 2026-11-02: wake failed with 23505).
// Real migrations, fake sandbox; disposable *_e2e PG on loopback.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { ensureBotRuntime } from './bot-runtime'
import { ensureRecordedBotHarnessRuntime } from './bot-runtime-records'

const url = process.env.E2E_DATABASE_URL
if (url) {
  const u = new URL(url)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname), 'loopback only')
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/, 'database name must end in _e2e')
} else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs E2E_DATABASE_URL')

test('a bot runtime follows its computer to a new device and survives an unbound agent', { skip: !url, timeout: 120000 }, async () => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `bot_runtime_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, database, 'template0')
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 2 })
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const f of orderMigrations((await readdir(dir)).filter(f => f.endsWith('.sql')))) await pool.query(await readFile(new URL(f, dir), 'utf8'))
    const owner = 'owner', workspaceId = randomUUID(), botId = randomUUID(), sandboxId = 'sandbox-bot'
    const harnesses = JSON.stringify([{ harness: 'codex', installed: true, subscriptionBroker: true, computerBroker: true }, { harness: 'claude_code', installed: true, subscriptionBroker: true, computerBroker: true }])
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Fixture','bot-runtime@example.invalid',true,now(),now())`, [owner])
    await pool.query(`INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,'Fixture Bot')`, [botId, workspaceId, owner])
    const device = async () => {
      const id = randomUUID()
      await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,harnesses) VALUES ($1,$2,'Cloud computer','cloud',true,$3)`, [id, owner, harnesses])
      return id
    }
    const first = await device()
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES ($1,$2,$3,$4,$5,'running',true)`, [workspaceId, owner, randomUUID(), sandboxId, first])
    await pool.query(`INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)`, [botId, workspaceId, owner])
    const sandbox = { sandboxId, commands: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } } as never
    const actor = { userId: owner, workspaceId }
    const agents = async () => (await pool.query(`SELECT x.harness,x."agentId",x."repoId",a."deviceId",repo."deviceId" AS "repoDevice" FROM bot_cloud_runtimes x JOIN agents a ON a.id=x."agentId" JOIN device_repos repo ON repo.id=x."repoId" WHERE x."botId"=$1 ORDER BY x.harness`, [botId])).rows

    const reports = JSON.parse(harnesses)
    await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [first, JSON.stringify(reports.map((info: object) => ({ ...info, subscriptionPreflight: 'env_not_clean' })))])
    await assert.rejects(ensureBotRuntime(pool, actor, botId, sandbox, first), /Bot runtime unavailable/)
    assert.equal((await agents()).length, 0, 'a failed self-test cannot provision an executor from an old broker flag')
    await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [first, JSON.stringify(reports.map((info: { harness: string }) => ({ ...info, ...(info.harness === 'claude_code' ? { subscriptionPreflight: 'env_not_clean' } : {}) })))])
    assert.deepEqual((await ensureBotRuntime(pool, actor, botId, sandbox, first)).map(r => r.harness), ['codex'], 'the other provider still provisions normally')
    await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [first, harnesses])
    const created = await ensureBotRuntime(pool, actor, botId, sandbox, first)
    assert.deepEqual(created.map(r => r.harness), ['claude_code', 'codex'])
    const before = await agents()

    for (const detail of ['env_not_clean', 'cli_missing', 'cli_version_mismatch', 'adapter_start_failed']) {
      await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [first, JSON.stringify(reports.map((info: { harness: string }) => ({ ...info, ...(info.harness === 'claude_code' ? { subscriptionPreflight: detail } : {}) })))])
      assert.deepEqual((await ensureBotRuntime(pool, actor, botId, sandbox, first)).map(r => r.harness), ['codex'], 'a recorded executor is not usable after its self-test fails')
      assert.equal(await ensureRecordedBotHarnessRuntime(pool, actor, botId, 'claude_code'), null, detail)
      assert.ok(await ensureRecordedBotHarnessRuntime(pool, actor, botId, 'codex'), 'a different healthy target remains available')
    }
    await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [first, harnesses])

    // A device removal unbinds every agent on it, the bot's hidden ones included.
    await pool.query('UPDATE agents SET "deviceId"=NULL WHERE "deviceId"=$1', [first])
    await ensureBotRuntime(pool, actor, botId, sandbox, first)
    assert.deepEqual((await agents()).map(r => [r.harness, r.agentId, r.deviceId]), before.map(r => [r.harness, r.agentId, first]), 'the same agents are bound to the device again')

    // The machine gets a new device: the runtime moves with its agents and a repo on that device.
    const second = await device()
    await pool.query('UPDATE cloud_machines SET "deviceId"=$3 WHERE "workspaceId"=$1 AND "ownerId"=$2', [workspaceId, owner, second])
    await ensureBotRuntime(pool, actor, botId, sandbox, second)
    const moved = await agents()
    assert.deepEqual(moved.map(r => [r.harness, r.agentId, r.deviceId, r.repoDevice]), before.map(r => [r.harness, r.agentId, second, second]))
    assert.equal(Number((await pool.query('SELECT count(*) FROM agents WHERE "userId"=$1', [owner])).rows[0].count), 2, 'no extra agent is created')

    // A runtime row removed without its agents (a bot handed over and back, production 2026-11-02): the wake takes
    // this owner's hidden agents back instead of failing on their name (23505).
    await pool.query('DELETE FROM bot_cloud_runtimes WHERE "botId"=$1', [botId])
    await ensureBotRuntime(pool, actor, botId, sandbox, second)
    assert.deepEqual((await agents()).map(r => [r.harness, r.agentId]), before.map(r => [r.harness, r.agentId]), 'the same agents again')

    // Only this owner's hidden agent on this device: an ordinary agent with that name, or one on another device, is never taken.
    await pool.query('DELETE FROM bot_cloud_runtimes WHERE "botId"=$1', [botId])
    const [claude, codex] = before
    await pool.query('UPDATE agents SET instructions=$2 WHERE id=$1', [claude.agentId, 'Ordinary agent the person wrote'])
    await pool.query('UPDATE agents SET "deviceId"=$2 WHERE id=$1', [codex.agentId, first])
    await assert.rejects(ensureBotRuntime(pool, actor, botId, sandbox, second), (error: { code?: string }) => error.code === '23505')
    assert.equal((await agents()).length, 0, 'nothing taken over, nothing half-made')
  } finally {
    // Not pool.end() then a FORCE drop: the drop could kill a still-closing client (57P01, uncaught).
    await dropTestDatabase(admin, database, pool)
    await admin.end()
  }
})
