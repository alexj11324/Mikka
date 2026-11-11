import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { applyMigration, planMigration } from '../scripts/migration-steps.mjs'
import { scopeMigrationBeforeCommit } from '../scripts/scope-migration-history.mjs'
import { repairPersonalResourcePrivacy } from '../scripts/repair-personal-resource-privacy.mjs'

const url = process.env.E2E_DATABASE_URL
if (url && !disposableDatabase()) throw new Error('Personal privacy tests require isolated loopback *_e2e databases')
if (!url && process.env.REQUIRE_DB === '1') throw new Error('Required personal privacy database is missing')

test('personal resources stay private through sharing and audited split-database repair', { skip: !url, timeout: 240_000 }, async t => {
  const suffix = randomUUID().replaceAll('-', '')
  const appName = `privacy_app_${suffix}_e2e`, wsName = `privacy_ws_${suffix}_e2e`
  const admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE DATABASE "${appName}" TEMPLATE template0`)
  await admin.query(`CREATE DATABASE "${wsName}" TEMPLATE template0`)
  const appURL = new URL(url!), wsURL = new URL(url!)
  appURL.pathname = `/${appName}`; wsURL.pathname = `/${wsName}`
  const app = new Pool({ connectionString: appURL.toString(), max: 5 })
  const ws = new Pool({ connectionString: wsURL.toString(), max: 5 })
  const previous = { app: process.env.MIKKA_DATABASE_URL, ws: process.env.DATABASE_URL }
  process.env.MIKKA_DATABASE_URL = appURL.toString(); process.env.DATABASE_URL = wsURL.toString()
  let moduleApp: Pool | undefined, moduleWs: Pool | undefined
  try {
    const directory = new URL('../drizzle/', import.meta.url)
    const files = orderMigrations((await readdir(directory)).filter(file => file.endsWith('.sql')))
    for (const pool of [app, ws]) await pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL DEFAULT now())')
    const migrate = async (names: string[]) => {
      for (const name of names) {
        const source = await readFile(new URL(name, directory), 'utf8'), plan = planMigration(name, source)
        const client = await (plan.target === 'DATABASE_URL' ? ws : app).connect()
        try {
          const scoped = scopeMigrationBeforeCommit(name, source)
          await applyMigration(client, name, scoped === null ? plan : { ...plan, sql: scoped })
          if (scoped !== null) await client.query('COMMIT')
        } finally { client.release() }
      }
    }
    const boundary = '20261110150005_resource_acl.sql'
    await migrate(files.filter(file => file < boundary))
    const owner = `owner-${suffix}`, outsider = `outsider-${suffix}`, member = `member-${suffix}`, service = `service-${suffix}`
    const personal = randomUUID(), team = randomUUID(), historical = randomUUID(), teamTask = randomUUID(), sharedBot = randomUUID()
    for (const id of [owner, outsider, member]) await app.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$1||\'@privacy.example.invalid\',true,now(),now())', [id])
    for (const [id, kind] of [[personal, 'personal'], [team, 'team']]) {
      await ws.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Privacy fixture\',$3)', [id, owner, kind])
      await ws.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,\'admin\',\'active\')', [id, owner])
    }
    await ws.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,\'member\',\'active\')', [team, member])
    const insertTask = (id: string, tenant: string) => app.query('INSERT INTO issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority) VALUES($1,$2,$3,\'bound\',\'personal\',\'Privacy fixture\',\'{"type":"doc","content":[]}\',\'todo\',\'normal\')', [id, owner, tenant])
    await insertTask(historical, personal)
    await migrate(files.filter(file => file >= boundary))
    await insertTask(teamTask, team)
    // Explicit historical state also permits this suite to run after the SQL
    // default becomes private; it must never weaken that new default.
    await app.query('UPDATE resource_access_policies SET visibility=\'shared\' WHERE kind=\'task\' AND id=ANY($1::uuid[])', [[historical, teamTask]])
    await app.query('INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance) VALUES(\'bot\',$1,$2,$3,\'shared\',\'created\')', [sharedBot, personal, owner])
    for (const [kind, subject] of [['account', outsider], ['service', service]]) {
      await app.query('INSERT INTO resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities,"expiresAt") VALUES(\'task\',$1,$2,$3,\'{canReadContent}\',\'2030-01-01T00:00:00Z\')', [historical, kind, subject])
    }
    const { pool } = await import('../lib/db'); moduleApp = pool
    const { workspacePool } = await import('../lib/workspace-db'); moduleWs = workspacePool
    const { changeResourceAccess } = await import('../lib/resource-access/store')
    const { issueForUser } = await import('../lib/issue-access')
    const policies = () => app.query('SELECT kind,id,visibility,revision,provenance,"parentKind","parentId" FROM resource_access_policies ORDER BY kind,id').then(result => result.rows)
    const grants = () => app.query('SELECT * FROM resource_access_grants ORDER BY "resourceKind","resourceId","subjectKind","subjectId"').then(result => result.rows)
    const repairAudits = () => app.query('SELECT "resourceKind","resourceId","actorId",detail FROM resource_access_events WHERE source=\'personal_resource_privacy_repair\' ORDER BY "resourceKind","resourceId"').then(result => result.rows)
    const allowed = (subject: string, kind: string = 'account') => app.query('SELECT mikka_resource_acl_allowed($1,$2,$3,\'task\',$4,\'canReadContent\') AS allowed', [kind, subject, personal, historical]).then(result => result.rows[0].allowed)

    await t.test('personal blanket sharing is refused for every resource kind, even with explicit confirmation', async () => {
      for (const kind of ['task', 'thread', 'project', 'artifact', 'bot', 'chat'] as const) {
        const id = randomUUID()
        await app.query('INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance) VALUES($1,$2,$3,$4,\'private\',\'created\')', [kind, id, personal, owner])
        const before = await policies(), beforeGrants = await grants()
        for (const confirmExpansion of [false, true]) await assert.rejects(changeResourceAccess(owner, { kind, id, workspaceId: personal },
          { expectedRevision: 1, visibility: 'shared', grants: [], confirmExpansion }), { code: 'validationGeneric' })
        assert.deepEqual(await policies(), before)
        assert.deepEqual(await grants(), beforeGrants)
      }
    })

    await t.test('dry-run changes nothing; apply keeps the Workspace lock, grants and team behavior; replay adds no audit', async () => {
      const before = await policies(), beforeGrants = await grants()
      const dry = await repairPersonalResourcePrivacy(app, ws)
      assert.equal(dry.dryRun, true); assert.equal(dry.candidates, 2); assert.equal(dry.repaired, 0)
      assert.deepEqual(await policies(), before); assert.deepEqual(await grants(), beforeGrants)
      assert.equal((await repairAudits()).length, 0)
      assert.equal(await allowed(member), true, 'historical shared root admits any account at the pure ACL layer')
      assert.equal(await issueForUser(member, historical), null, 'the normal boundary still refuses another Workspace member')

      let release!: () => void, entered!: () => void
      const hold = new Promise<void>(resolve => { release = resolve })
      const waiting = new Promise<void>(resolve => { entered = resolve })
      let intercepted = false
      const blocked = { async connect() {
        const client = await app.connect()
        return { release: () => client.release(), async query(text: string, values?: unknown[]) {
          if (!intercepted && text.startsWith('UPDATE resource_access_policies')) { intercepted = true; entered(); await hold }
          return client.query(text, values)
        } }
      } }
      const repairing = repairPersonalResourcePrivacy(blocked, ws, { dryRun: false, workspaceIds: [personal, team], actorId: owner })
      await waiting
      const contender = await ws.connect()
      try {
        await contender.query('BEGIN')
        await contender.query("SET LOCAL lock_timeout='100ms'")
        await assert.rejects(contender.query('UPDATE mikka_workspaces SET name=name WHERE id=$1', [personal]), { code: '55P03' })
      } finally { await contender.query('ROLLBACK'); contender.release(); release() }
      const applied = await repairing
      assert.equal(applied.repaired, 2)
      assert.deepEqual(await grants(), beforeGrants)
      const after = await policies()
      assert.deepEqual(after.find(row => row.id === teamTask), before.find(row => row.id === teamTask))
      assert.equal(await allowed(member), false)
      assert.equal(await allowed(owner), true)
      assert.equal(await allowed(outsider), true, 'the explicit historical account grant is retained')
      assert.equal(await allowed(service, 'service'), true, 'service keeps only its explicit grant')
      assert.equal(await issueForUser(outsider, historical), null)
      assert.equal((await issueForUser(member, teamTask))?.id, teamTask)
      const events = await repairAudits()
      assert.equal(events.length, 2)
      for (const event of events) {
        assert.equal(event.actorId, owner)
        assert.equal(event.detail.previousVisibility, 'shared'); assert.equal(event.detail.visibility, 'private')
      }
      const replay = await repairPersonalResourcePrivacy(app, ws, { dryRun: false, workspaceIds: [personal], actorId: owner })
      assert.equal(replay.repaired, 0); assert.equal(replay.candidates, 0)
      assert.deepEqual(await policies(), after); assert.deepEqual(await repairAudits(), events)
      assert.deepEqual(await grants(), beforeGrants)
    })
    await t.test('ownership anomalies are reported without transferring ownership or revoking explicit grants', async () => {
      const id = randomUUID()
      await app.query('INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance) VALUES(\'artifact\',$1,$2,$3,\'shared\',\'created\')', [id, personal, outsider])
      const beforeGrants = await grants()
      const dry = await repairPersonalResourcePrivacy(app, ws, { workspaceIds: [personal] })
      assert.equal(dry.ownerMismatches, 1); assert.equal(dry.candidates, 1)
      const applied = await repairPersonalResourcePrivacy(app, ws, { dryRun: false, workspaceIds: [personal], actorId: owner })
      assert.equal(applied.ownerMismatches, 1); assert.equal(applied.repaired, 1)
      assert.equal(applied.liveInvalidations, 'not_sent')
      assert.deepEqual((await app.query('SELECT "ownerId",visibility FROM resource_access_policies WHERE kind=\'artifact\' AND id=$1', [id])).rows[0], { ownerId: outsider, visibility: 'private' })
      assert.deepEqual(await grants(), beforeGrants)
      const replay = await repairPersonalResourcePrivacy(app, ws, { dryRun: false, workspaceIds: [personal], actorId: owner })
      assert.equal(replay.ownerMismatches, 1, 'private is not evidence that ownership was reconciled')
      assert.equal(replay.repaired, 0)
    })
    assert.equal((await app.query("SELECT to_regclass('mikka_workspaces') AS table")).rows[0].table, null)
    assert.equal((await ws.query("SELECT to_regclass('resource_access_policies') AS table")).rows[0].table, null)
  } finally {
    await moduleApp?.end(); await moduleWs?.end()
    await dropTestDatabase(admin, appName, app); await dropTestDatabase(admin, wsName, ws); await admin.end()
    if (previous.app === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = previous.app
    if (previous.ws === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.ws
  }
})
