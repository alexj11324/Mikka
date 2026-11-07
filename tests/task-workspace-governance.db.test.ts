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
import { backfillTaskWorkspaces } from '../scripts/task-workspace-backfill.mjs'

const url = process.env.E2E_DATABASE_URL
if (url && !disposableDatabase()) throw new Error('Workspace governance tests require a loopback *_e2e database')
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Workspace governance database tests cannot skip in required CI')

test('workspace ownership: real split-database migration, ACL, immutable provenance and membership races', { skip: !url, timeout: 240_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const suffix = randomUUID().replaceAll('-', '')
  const appName = `governance_app_${suffix}_e2e`, workspaceName = `governance_ws_${suffix}_e2e`
  await admin.query(`CREATE DATABASE "${appName}" TEMPLATE template0`)
  await admin.query(`CREATE DATABASE "${workspaceName}" TEMPLATE template0`)
  const appUrl = new URL(url!), workspaceUrl = new URL(url!)
  appUrl.pathname = `/${appName}`; workspaceUrl.pathname = `/${workspaceName}`
  const app = new Pool({ connectionString: appUrl.toString(), max: 5 })
  const workspace = new Pool({ connectionString: workspaceUrl.toString(), max: 5 })
  const previous = { app: process.env.MIKKA_DATABASE_URL, workspace: process.env.DATABASE_URL }
  process.env.MIKKA_DATABASE_URL = appUrl.toString(); process.env.DATABASE_URL = workspaceUrl.toString()
  let moduleApp: Pool | undefined, moduleWorkspace: Pool | undefined
  try {
    const directory = new URL('../drizzle/', import.meta.url)
    const migrations = orderMigrations((await readdir(directory)).filter(file => file.endsWith('.sql')))
    const boundary = '20261107121000_task_workspace_ownership.sql'
    for (const pool of [app, workspace]) await pool.query('CREATE TABLE schema_migrations (name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL DEFAULT now())')
    const migrate = async (names: string[]) => {
      for (const name of names) {
        const source = await readFile(new URL(name, directory), 'utf8')
        const plan = planMigration(name, source)
        const client = await (plan.target === 'DATABASE_URL' ? workspace : app).connect()
        try {
          const scope = scopeMigrationBeforeCommit(name, source)
          await applyMigration(client, name, scope === null ? plan : { ...plan, sql: scope })
          if (scope !== null) await client.query('COMMIT')
        } finally { client.release() }
      }
    }
    await migrate(migrations.filter(name => name < boundary))
    const owner = `owner-${suffix}`, member = `member-${suffix}`, stranger = `stranger-${suffix}`
    const alpha = randomUUID(), beta = randomUUID(), personal = randomUUID(), team = randomUUID()
    const bound = randomUUID(), conflict = randomUUID(), unresolved = randomUUID(), teamless = randomUUID()
    const botA = randomUUID(), botB = randomUUID(), agent = randomUUID(), runA = randomUUID(), runConflict = randomUUID(), artifact = randomUUID()
    for (const id of [owner, member, stranger]) await app.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$1||\'@governance.example.invalid\',true,now(),now())', [id])
    for (const [id, kind] of [[alpha, 'team'], [beta, 'team'], [personal, 'personal']]) {
      await workspace.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Governance fixture\',$3)', [id, owner, kind])
      await workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,\'admin\',\'active\')', [id, owner])
    }
    await workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,\'member\',\'active\')', [alpha, member])
    await workspace.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Grouping\',\'GOV\')', [team, alpha, owner])
    for (const id of [bound, conflict, unresolved]) await app.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'Personal title is not proof\',\'{"type":"doc"}\',\'todo\',\'normal\',\'workspace\')', [id, owner])
    for (const id of [bound, conflict]) await workspace.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [id, team, alpha, owner])
    await app.query('INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,\'codex\',\'Fixture\')', [agent, owner])
    for (const [id, tenant] of [[botA, alpha], [botB, beta]]) await app.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Fixture\')', [id, owner, tenant])
    for (const [id, task, bot] of [[runA, bound, botA], [runConflict, conflict, botB]]) await app.query('INSERT INTO agent_runs(id,"userId","agentId","issueId","botId",status) VALUES($1,$2,$3,$4,$5,\'succeeded\')', [id, owner, agent, task, bot])
    await app.query('INSERT INTO artifacts(id,"userId","runId","issueId",kind,title) VALUES($1,$2,$3,$4,\'markdown\',\'Fixture\')', [artifact, owner, runA, bound])
    await app.query('INSERT INTO artifact_versions(id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") VALUES($1,$2,1,\'fixture\',\'tenant content\',\'fixture\',14,\'Fixture\')', [randomUUID(), artifact])
    const before = (await app.query('SELECT id,content,"scopeVersion" FROM issues WHERE id=$1', [bound])).rows[0]
    await migrate(migrations.filter(name => name >= boundary))
    const result = await backfillTaskWorkspaces(app, workspace)
    assert.equal(result.bound, 1); assert.equal(result.pending, 2)
    assert.equal(result.runsBound, 1); assert.equal(result.artifactsBound, 1)
    const after = (await app.query('SELECT id,content,"scopeVersion","workspaceId" FROM issues WHERE id=$1', [bound])).rows[0]
    assert.deepEqual({ id: after.id, content: after.content, scopeVersion: after.scopeVersion }, before, 'migration preserves UUID, mandatory number and publication generation')
    assert.equal(after.workspaceId, alpha)
    const repeat = await backfillTaskWorkspaces(app, workspace)
    assert.equal(repeat.bound, 0); assert.equal(repeat.runsBound, 0); assert.equal(repeat.artifactsBound, 0)
    assert.deepEqual((await app.query('SELECT reason FROM issue_workspace_repairs ORDER BY reason')).rows.map(row => row.reason), ['conflicting_evidence', 'missing_evidence'])

    const { db, pool } = await import('../lib/db'); moduleApp = pool
    const { workspacePool } = await import('../lib/workspace-db'); moduleWorkspace = workspacePool
    const { issueForUser } = await import('../lib/issue-access')
    const { activeTaskWorkspaces, withTaskWorkspace } = await import('../lib/task-workspace')
    const { tokenWorkspace } = await import('../lib/tokens/principal')
    const { readArtifact, readArtifactContent, createShare, sharedArtifact } = await import('../lib/artifacts/store')
    const { artifactOutsideToken, runOutsideToken } = await import('../lib/tokens/scope')

    await t.test('pending resources never inherit the creator personal workspace', async () => {
      for (const id of [conflict, unresolved]) {
        assert.equal(await issueForUser(owner, id), null)
        assert.equal(await issueForUser({ id: owner, [tokenWorkspace]: personal }, id), null)
      }
      assert.equal(await runOutsideToken({ id: owner, [tokenWorkspace]: beta }, runConflict), true)
    })
    await app.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope) VALUES($1,$2,$3,\'No Team required\',\'{"type":"doc"}\',\'todo\',\'normal\',\'personal\')', [teamless, owner, alpha])
    await t.test('members can read a tenant task without a Team; selected/PAT tenant has no owner bypass', async () => {
      assert.equal((await issueForUser(member, teamless))?.id, teamless)
      assert.equal(await issueForUser(stranger, teamless), null)
      assert.equal(await issueForUser({ id: owner, [tokenWorkspace]: beta }, teamless), null)
      assert.equal((await issueForUser({ id: owner, [tokenWorkspace]: alpha }, teamless))?.id, teamless)
      await assert.rejects(withTaskWorkspace({ id: owner, [tokenWorkspace]: alpha }, beta, async () => assert.fail('wrong tenant write')), /workspaceAccessDenied/)
    })
    await t.test('tenant cannot be changed or cleared; run and artifact provenance must agree', async () => {
      for (const next of [beta, null]) await assert.rejects(app.query('UPDATE issues SET "workspaceId"=$2 WHERE id=$1', [teamless, next]), /taskWorkspaceTransferDenied/)
      await assert.rejects(app.query('INSERT INTO agent_runs(id,"userId","agentId","issueId","botId",status) VALUES($1,$2,$3,$4,$5,\'queued\')', [randomUUID(), owner, agent, teamless, botB]), /taskWorkspaceMismatch/)
      await assert.rejects(app.query('UPDATE agent_runs SET "workspaceId"=$2 WHERE id=$1', [runA, beta]), /taskWorkspaceTransferDenied/)
      await assert.rejects(app.query('UPDATE artifacts SET "workspaceId"=$2 WHERE id=$1', [artifact, beta]), /taskWorkspaceTransferDenied/)
      assert.equal(await artifactOutsideToken({ id: owner, [tokenWorkspace]: beta }, artifact), true)
      assert.equal(await readArtifact({ id: owner, [tokenWorkspace]: beta }, artifact), null)
      assert.equal((await readArtifactContent({ id: owner, [tokenWorkspace]: alpha }, artifact, 1))?.content, 'tenant content')
    })
    await t.test('membership is pinned until the app commit and the next read observes suspension', async () => {
      let entered!: () => void, release!: () => void
      const ready = new Promise<void>(resolve => { entered = resolve })
      const finish = new Promise<void>(resolve => { release = resolve })
      const writing = withTaskWorkspace(member, alpha, () => db.transaction(async tx => {
        const { sql } = await import('drizzle-orm')
        await tx.execute(sql`SELECT id FROM issues WHERE id=${teamless} FOR UPDATE`)
        entered(); await finish
      }))
      await ready
      const updater = await workspace.connect()
      let suspension: Promise<unknown> | undefined
      try {
        const pid = (await updater.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        suspension = updater.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, member])
        let blocked = false
        for (let i = 0; i < 100 && !blocked; i++) {
          blocked = (await workspace.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock'
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.equal(blocked, true, 'suspension waits for the authorized app write to commit')
      } finally { release(); await writing; await suspension; updater.release() }
      assert.deepEqual(await activeTaskWorkspaces(member, alpha), [])
      assert.equal(await issueForUser(member, teamless), null)
    })
    await t.test('suspending an artifact issuer closes shared links but leaves other workspace access intact', async () => {
      const link = await createShare(owner, artifact)
      assert.ok(link); assert.ok(await sharedArtifact(link.token))
      await workspace.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner])
      assert.equal(await readArtifact(owner, artifact), null)
      assert.equal(await sharedArtifact(link.token), null)
      assert.equal((await activeTaskWorkspaces(owner, beta))[0]?.id, beta)
      assert.equal((await activeTaskWorkspaces(owner, personal))[0]?.id, personal)
    })
  } finally {
    await Promise.all([moduleApp?.end(), moduleWorkspace?.end()])
    await dropTestDatabase(admin, appName, app)
    await dropTestDatabase(admin, workspaceName, workspace)
    await admin.end()
    if (previous.app === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = previous.app
    if (previous.workspace === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.workspace
  }
})
