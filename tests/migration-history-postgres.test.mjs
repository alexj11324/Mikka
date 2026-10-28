import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import test from 'node:test'
import { Pool } from 'pg'
import { MIGRATION_HISTORY } from '../scripts/migration-history.mjs'

const execute = promisify(execFile)
const MAIN = 'dd6d8d4febbfe56bba5671cc5302c20f8e0e533d'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

test('PG17 current-main upgrades preserve actual historical SQL/ledger in shared and split targets', {
  skip: !process.env.IMPROVEMENT_TEST_URL, timeout: 120000,
}, async t => {
  const target = new URL(process.env.IMPROVEMENT_TEST_URL)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
  assert.equal(target.pathname, '/mikka_improvement')
  const mainPaths = git('ls-tree', '-r', '--name-only', MAIN, 'drizzle/').trim().split('\n').filter(path => path.endsWith('.sql'))
  // Reuse the pinned main's own ordering, including artifact compatibility.
  // Only trusted repository source is loaded, never a model or network payload.
  const source = git('show', `${MAIN}:scripts/migration-order.mjs`)
  const { orderMigrations } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  const mainNames = orderMigrations(mainPaths.map(path => path.slice('drizzle/'.length)))
  const mainSql = new Map(mainNames.map(name => [name, git('show', `${MAIN}:drizzle/${name}`)]))
  const entries = await Promise.all(Object.entries(MIGRATION_HISTORY).map(async ([name, entry]) =>
    ({ name, ...entry, sql: await readFile(new URL('../drizzle/' + name, import.meta.url), 'utf8') })))
  for (const entry of entries) {
    assert.equal(mainSql.has(entry.name), false)
    assert.ok(![...mainSql.values()].includes(entry.sql), 'Do not infer equivalence from table names')
  }
  const admin = new Pool({ connectionString: target.toString(), max: 1 })
  const clients = []
  t.after(async () => { await Promise.all(clients.map(client => client.end())); await admin.end() })
  assert.ok(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num) >= 170000)
  async function database() {
    // Extensions are database-wide. Use a fresh owned disposable database so
    // pg_trgm from one retained fixture cannot leak across another's schema.
    const name = `mikka_migration_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${name}"`)
    const url = new URL(target)
    url.pathname = `/${name}`
    url.searchParams.delete('options')
    const db = new Pool({ connectionString: url.toString(), max: 1 })
    clients.push(db)
    await db.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL DEFAULT now())')
    for (const [name, sql] of mainSql) {
      await db.query(sql)
      await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [name])
    }
    const id = randomUUID(), owner = `synthetic-${id}`
    await db.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'synthetic migration owner',$2,true,now(),now())`, [owner,`${id}@example.invalid`])
    await db.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,'migration sentinel','{}','todo','normal')`, [id, owner])
    const deviceId=randomUUID(),agentId=randomUUID(),repoId=randomUUID(),runId=randomUUID()
    await db.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'synthetic migration device\')',[deviceId,owner])
    await db.query('INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,\'codex\',\'synthetic migration agent\',$3)',[agentId,owner,deviceId])
    await db.query('INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,$3,\'/synthetic/migration\')',[repoId,deviceId,owner])
    await db.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"sessionId",report,"finishedAt")
      VALUES($1,$2,$3,$4,$5,$6,'succeeded','synthetic migration session','{"summary":"preserve actual stored bytes"}',now())`,[runId,owner,id,agentId,deviceId,repoId])
    const sentinel = {
      issue:(await db.query('SELECT * FROM issues WHERE id=$1', [id])).rows[0],
      user:(await db.query('SELECT * FROM "user" WHERE id=$1', [owner])).rows[0],
      run:(await db.query('SELECT id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"sessionId",report,"finishedAt" FROM agent_runs WHERE id=$1',[runId])).rows[0],
    }
    return { db, url: url.toString(), id, owner, runId, sentinel, database: name }
  }
  async function applyLegacy(database, aliases) {
    for (const [index, entry] of entries.entries()) {
      // This is a genuine isolated execution before recording its old name,
      // not an invented applied-state row or production-history assertion.
      await database.db.query(entry.sql)
      await database.db.query('INSERT INTO schema_migrations(name) VALUES($1)', [entry.aliases[aliases === 'mixed' ? index % 2 : aliases]])
    }
  }
  async function migrate(app, workspace = app) {
    return execute(process.execPath, ['scripts/migrate.mjs'], {
      cwd: new URL('..', import.meta.url), timeout: 30000,
      env: { ...process.env, MIGRATE: '1', MIKKA_DATABASE_URL: app.url, DATABASE_URL: workspace.url },
    })
  }
  async function verify(database, canonicalCount) {
    const ledger = (await database.db.query('SELECT * FROM schema_migrations ORDER BY name')).rows
    assert.equal(ledger.filter(row => entries.some(entry => entry.name === row.name)).length, canonicalCount)
    assert.deepEqual((await database.db.query('SELECT * FROM issues WHERE id=$1', [database.id])).rows[0], database.sentinel.issue)
    assert.deepEqual((await database.db.query('SELECT * FROM "user" WHERE id=$1', [database.owner])).rows[0], database.sentinel.user)
    assert.deepEqual((await database.db.query('SELECT id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"sessionId",report,"finishedAt" FROM agent_runs WHERE id=$1',[database.runId])).rows[0], database.sentinel.run)
    assert.equal((await database.db.query("SELECT to_regclass('factory_tasks')::text AS name")).rows[0].name, 'factory_tasks')
    assert.equal((await database.db.query("SELECT to_regclass('improvement_skill_receipts')::text AS name")).rows[0].name, 'improvement_skill_receipts')
    return ledger
  }
  await t.test('fresh current-main receives exactly seven real canonical migrations and replays without new rows', async () => {
    const app = await database()
    await migrate(app)
    const before = await verify(app, 7)
    await migrate(app)
    assert.deepEqual(await verify(app, 7), before)
  })
  await t.test('both historical name families and mixed histories skip only byte-identical SQL without relabeling', async () => {
    for (const aliases of [0, 1, 'mixed']) {
      const app = await database(); await applyLegacy(app, aliases)
      const before = (await app.db.query('SELECT * FROM schema_migrations ORDER BY name')).rows
      const result = await migrate(app)
      assert.ok(entries.every(entry => !result.stdout.includes(`applied ${entry.name}`)))
      assert.deepEqual(await verify(app, 0), before)
    }
  })
  await t.test('workspace history cannot suppress missing application migrations on split targets', async () => {
    const app = await database(), workspace = await database()
    await applyLegacy(workspace, 0)
    const before = (await workspace.db.query('SELECT * FROM schema_migrations ORDER BY name')).rows
    await migrate(app, workspace)
    await verify(app, 7)
    assert.deepEqual(await verify(workspace, 0), before)
  })
})
