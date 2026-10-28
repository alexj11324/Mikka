import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// This suite must run after tracked migrations in GitHub's disposable service,
// never against a developer database or a Preview/production application DB.
const url = process.env.E2E_DATABASE_URL
if (!url || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true'
  || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/mikka_e2e'
  || process.env.MIKKA_DATABASE_URL !== url || process.env.DATABASE_URL !== url) {
  throw new Error('Local runtime integration requires GitHub CI ephemeral mikka_e2e')
}

test('device identity convergence, repository URL deduplication and history preservation', async () => {
  const { Pool } = await import('pg')
  const { readFile } = await import('node:fs/promises')
  const { ensureDeviceAgents } = await import('../lib/device-agents')
  const { ensureDeviceRepository } = await import('../lib/device-repositories')
  const { executionBotName, runBotName } = await import('../lib/run-bot-name')
  const { enrichActivityActors } = await import('../lib/activity-actor-server')
  const { db, pool: applicationPool } = await import('../lib/db')
  const { agentRuns, agents } = await import('../lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const pool = new Pool({ connectionString: url, max: 12 })
  const owner = `local-runtime-${randomUUID()}`
  const first = randomUUID(), second = randomUUID(), issue = randomUUID(), run = randomUUID()
  const infos = [{ harness: 'claude_code' as const, installed: true, version: 'test' }, { harness: 'codex' as const, installed: true, version: 'test' }]
  try {
    // The E2E table bootstrap omits indexes; restore their tracked SQL so
    // ON CONFLICT and uniqueness assertions use the deployed constraints.
    await pool.query(await readFile(new URL('../drizzle/0001_agents_devices.sql', import.meta.url), 'utf8'))
    for (const id of [first, second]) await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,harnesses,"protocolVersion") VALUES ($1,$2,'Disposable local computer','local',$3,3)`, [id, owner, JSON.stringify(infos)])
    await Promise.all(Array.from({ length: 16 }, () => ensureDeviceAgents(pool, owner, first, infos)))
    await ensureDeviceAgents(pool, owner, second, infos)
    const rows = (await pool.query(`SELECT id,name,"deviceId",harness FROM agents WHERE "userId"=$1 ORDER BY name`, [owner])).rows
    assert.equal(rows.length, 4)
    assert.equal(new Set(rows.map(row => row.name)).size, 4)
    const codex = rows.find(row => row.deviceId === first && row.harness === 'codex')!

    // Hold the exact reconciliation lock. An ordinary unchanged heartbeat
    // must still finish: it does not enter the locked transaction path.
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('device-agents:' || $1,0))", [first])
      await Promise.race([
        ensureDeviceAgents(pool, owner, first, infos),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Unchanged heartbeat waited for identity lock')), 5_000); timer.unref() }),
      ])
    } finally { await blocker.query('ROLLBACK'); blocker.release() }

    const variants = ['example/local-runtime', 'https://github.com/example/local-runtime.git', 'git@github.com:example/local-runtime.git']
    const records = await Promise.all(Array.from({ length: 12 }, (_, i) => ensureDeviceRepository(owner, first, variants[i % variants.length]!)))
    assert.equal(new Set(records.map(row => row.id)).size, 1)
    assert.equal(records[0]!.repoPath, 'github.com/example/local-runtime')
    assert.equal(records[0]!.baseBranch, null)
    const other = await ensureDeviceRepository(owner, second, variants[0]!)
    assert.notEqual(other.id, records[0]!.id)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM repository_settings WHERE "userId"=$1', [owner])).rows[0].n, 0)

    const legacy = randomUUID()
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl","baseBranch") VALUES ($1,$2,$3,$4,$5,$6)', [legacy, first, owner, '/personal/checkout', 'git@github.com:example/legacy.git', 'release'])
    const migrated = await ensureDeviceRepository(owner, first, 'example/legacy')
    assert.equal(migrated.id, legacy)
    assert.equal(migrated.repoPath, 'github.com/example/legacy')
    assert.equal(migrated.remoteUrl, 'https://github.com/example/legacy.git')
    assert.equal(migrated.baseBranch, 'release')

    await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Disposable local task','{"type":"doc","content":[]}','todo','normal')`, [issue, owner])
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","baseBranch") VALUES ($1,$2,$3,$4,$5,$6,NULL)`, [run, owner, issue, codex.id, first, records[0]!.id])
    const [display] = await db.select({ name: runBotName }).from(agentRuns).innerJoin(agents, eq(agentRuns.agentId, agents.id)).where(eq(agentRuns.id, run))
    assert.equal(display?.name, 'Coordinator')
    const [identity] = await db.select({ name: executionBotName }).from(agents).where(eq(agents.id, codex.id))
    assert.equal(identity?.name, 'Coordinator', 'standalone activity/directory projections hide the device identity too')
    const [activity] = await enrichActivityActors([{ actorType: 'agent' as const, actorId: codex.id }], owner)
    assert.equal(activity.actor?.name, 'Coordinator')
    assert.equal(activity.actor?.id, codex.id, 'display names do not replace the technical actor ID')
    assert.equal((await pool.query('SELECT name FROM agents WHERE id=$1', [codex.id])).rows[0].name, `codex ${first}`, 'read projections never rename stored execution identities')
    await pool.query('UPDATE devices SET harnesses=$1 WHERE id=$2', [JSON.stringify([infos[0]]), first])
    await ensureDeviceAgents(pool, owner, first, [infos[0]!])
    assert.equal((await pool.query('SELECT "deviceId" FROM agents WHERE id=$1', [codex.id])).rows[0].deviceId, null)
    assert.equal((await pool.query('SELECT "agentId" FROM agent_runs WHERE id=$1', [run])).rows[0].agentId, codex.id)
    await pool.query('UPDATE devices SET harnesses=$1 WHERE id=$2', [JSON.stringify(infos), first])
    await ensureDeviceAgents(pool, owner, first, infos)
    assert.equal((await pool.query('SELECT "deviceId" FROM agents WHERE id=$1', [codex.id])).rows[0].deviceId, first)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agents WHERE "userId"=$1', [owner])).rows[0].n, 4)
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [run])
    await pool.query('DELETE FROM issues WHERE id=$1', [issue])
    await pool.query('DELETE FROM agents WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM device_repos WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM devices WHERE "ownerId"=$1', [owner])
    await pool.end()
    await applicationPool.end()
  }
})
