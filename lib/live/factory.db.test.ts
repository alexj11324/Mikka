import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { isolatedPostgresURL } from '../../tests/helpers/isolated-postgres.mjs'
import { afterCommit, observePoolCommits } from '../db/commit-effects'
import { factoryLiveScopes, factoryLiveTargets, factoryIssueLiveScope } from './factory'
import { liveChannelId } from './scope'

const url = process.env.E2E_DATABASE_URL
const ci = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
if (ci) assert.ok(url, 'CI must run actual isolated PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('real PG: committed invalidations, savepoint rollback, and canonical owner/workspace targets', { skip: !url, timeout: 120_000 }, async t => {
  const connectionString = await isolatedPostgresURL(url!)
  const admin = new Pool({ connectionString })
  const schema = `live_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 })
  observePoolCommits(pool)
  try {
    await pool.query(`CREATE TABLE issues (id uuid PRIMARY KEY,"userId" text,"workspaceId" uuid,"ownershipState" text NOT NULL,scope text NOT NULL);
      CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid);
      CREATE TABLE factory_tasks (id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"botId" uuid,"workspaceId" uuid,status text);
      CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY,"userId" text,kind text);
      CREATE TABLE mikka_workspace_members ("workspaceId" uuid,"userId" text,status text);
      CREATE TABLE mikka_team_issues ("issueId" uuid PRIMARY KEY,"workspaceId" uuid);`)
    const personal = randomUUID(), a = randomUUID(), b = randomUUID()
    await pool.query(`INSERT INTO mikka_workspaces VALUES ($1,'owner','personal'),($2,'owner','team'),($3,'owner','team')`, [personal, a, b])
    await pool.query(`INSERT INTO mikka_workspace_members VALUES ($1,'owner','active'),($2,'owner','active'),($3,'owner','active'),($2,'peer','active')`, [personal, a, b])
    async function fixture(owner: string, workspaceId: string | null, scope = 'workspace', withBot = true) {
      const id = randomUUID(), issueId = randomUUID(), botId = workspaceId && withBot ? randomUUID() : null
      await pool.query('INSERT INTO issues VALUES ($1,$2,$3,$4,$5)', [issueId, owner, workspaceId, workspaceId ? 'bound' : 'pending', scope])
      if (botId) await pool.query('INSERT INTO bots VALUES ($1,$2,$3)', [botId, owner, workspaceId])
      await pool.query(`INSERT INTO factory_tasks VALUES ($1,$2,$3,$4,$5,'pending')`, [id, owner, issueId, botId, workspaceId])
      return { id, issueId, botId }
    }
    const one = await fixture('owner', a), two = await fixture('owner', b), peer = await fixture('peer', a)
    const legacy = await fixture('owner', null, 'personal'), team = await fixture('owner', a, 'workspace', false)
    await pool.query('INSERT INTO mikka_team_issues VALUES ($1,$2)', [legacy.issueId, a])

    await t.test('same-owner different-workspace and same-workspace different-owner targets stay separate', async () => {
      const first = await factoryLiveScopes(pool, pool, one.id, 'owner')
      const second = await factoryLiveScopes(pool, pool, two.id, 'owner')
      const third = await factoryLiveScopes(pool, pool, peer.id, 'peer')
      assert.deepEqual(first?.task, { ownerId: 'owner', workspaceId: a })
      assert.deepEqual(second?.task, { ownerId: 'owner', workspaceId: b })
      assert.deepEqual(third?.task, { ownerId: 'peer', workspaceId: a })
      assert.equal(new Set([first!, second!, third!].map(target => liveChannelId(target.task))).size, 3)
      assert.equal(await factoryLiveScopes(pool, pool, peer.id, 'owner'), null)
      assert.deepEqual((await factoryLiveTargets(pool, pool, one.id, 'owner'))[0].events, [{ kind: 'factory_task', id: one.id }, { kind: 'factory_issue', id: one.issueId }])
      assert.equal(await factoryLiveScopes(pool, pool, legacy.id, 'owner'), null, 'a legacy personal scope and Team link cannot repair unresolved ownership at read time')
      assert.equal((await factoryLiveScopes(pool, pool, team.id, 'owner'))?.task.workspaceId, a)
    })

    await t.test('removed membership and a mismatched Bot owner cannot produce a target', async () => {
      await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='owner'`, [a])
      assert.equal(await factoryLiveScopes(pool, pool, one.id, 'owner'), null)
      assert.equal((await factoryLiveScopes(pool, pool, two.id, 'owner'))?.task.workspaceId, b)
      await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"='owner'`, [a])
      await pool.query(`UPDATE bots SET "ownerId"='peer' WHERE id=$1`, [one.botId])
      assert.equal(await factoryLiveScopes(pool, pool, one.id, 'owner'), null)
      await pool.query(`UPDATE bots SET "ownerId"='owner' WHERE id=$1`, [one.botId])
    })

    await t.test('task and issue keys share the stored tenant even when legacy scope or page selection differs', async () => {
      const emptyIssue = randomUUID()
      await pool.query(`INSERT INTO issues VALUES ($1,'owner',$2,'bound','personal')`, [emptyIssue, personal])
      assert.deepEqual(await factoryIssueLiveScope(pool, pool, emptyIssue, 'owner'), { ownerId: 'owner', workspaceId: personal }, 'the list can subscribe before its first Factory task exists')
      const task = await fixture('owner', a, 'personal')
      const scopes = await factoryLiveScopes(pool, pool, task.id, 'owner')
      assert.deepEqual(scopes?.task, { ownerId: 'owner', workspaceId: a })
      assert.deepEqual(scopes?.issue, { ownerId: 'owner', workspaceId: a })
      const targets = await factoryLiveTargets(pool, pool, task.id, 'owner')
      assert.deepEqual(targets, [
        { scope: { ownerId: 'owner', workspaceId: a }, events: [{ kind: 'factory_task', id: task.id }, { kind: 'factory_issue', id: task.issueId }] },
      ])
      assert.equal(targets.some(target => target.scope.workspaceId === b), false, 'the currently selected unrelated workspace is not a publish target')
      assert.deepEqual(await factoryLiveTargets(pool, pool, team.id, 'owner'), [{
        scope: { ownerId: 'owner', workspaceId: a },
        events: [{ kind: 'factory_task', id: team.id }, { kind: 'factory_issue', id: team.issueId }],
      }], 'a shared canonical scope needs one push')
      assert.equal((await pool.query('SELECT 1 FROM mikka_team_issues WHERE "issueId"=$1', [team.issueId])).rowCount, 0, 'a shared task needs no Team link to publish in its tenant')
      // This minimal schema deliberately permits malformed historical rows so
      // the read-side agreement check is exercised independently of triggers.
      await pool.query('UPDATE factory_tasks SET "workspaceId"=$2 WHERE id=$1', [task.id, b])
      assert.deepEqual(await factoryLiveTargets(pool, pool, task.id, 'owner'), [])
      await pool.query('UPDATE factory_tasks SET "workspaceId"=$2 WHERE id=$1', [task.id, a])
      await pool.query('UPDATE bots SET "workspaceId"=$2 WHERE id=$1', [task.botId, b])
      assert.deepEqual(await factoryLiveTargets(pool, pool, task.id, 'owner'), [])
      await pool.query(`INSERT INTO mikka_workspace_members VALUES ($1,'peer','active')`, [personal])
      const wrongPersonalOwner = await fixture('peer', personal, 'personal', false)
      assert.deepEqual(await factoryLiveTargets(pool, pool, wrongPersonalOwner.id, 'peer'), [], 'an accidental membership never grants another account\'s personal tenant')
    })

    await t.test('outer COMMIT is visible to a separate connection before a queued effect runs', async () => {
      const tx = await pool.connect(), reader = await pool.connect()
      const sent: string[] = []
      let observed: Promise<void> = Promise.resolve()
      try {
        await tx.query('BEGIN')
        await tx.query(`UPDATE factory_tasks SET status='passed' WHERE id=$1`, [one.id])
        afterCommit(tx, one.id, () => {
          sent.push(one.id)
          observed = reader.query('SELECT status FROM factory_tasks WHERE id=$1', [one.id]).then(result => { assert.equal(result.rows[0].status, 'passed') })
        })
        assert.deepEqual(sent, [])
        assert.equal((await reader.query('SELECT status FROM factory_tasks WHERE id=$1', [one.id])).rows[0].status, 'pending')
        await tx.query('COMMIT'); await observed
        assert.deepEqual(sent, [one.id])
      } finally { tx.release(); reader.release() }
    })

    await t.test('savepoint and failed-transaction rollback do not publish reverted state', async () => {
      const tx = await pool.connect(), sent: string[] = []
      try {
        await tx.query('BEGIN')
        afterCommit(tx, one.id, () => { sent.push('before') })
        await tx.query('SAVEPOINT retry')
        await tx.query(`UPDATE factory_tasks SET status='failed' WHERE id=$1`, [one.id])
        afterCommit(tx, one.id, () => { sent.push('reverted') })
        afterCommit(tx, two.id, () => { sent.push('other-reverted') })
        await tx.query('ROLLBACK TO SAVEPOINT retry')
        await tx.query('COMMIT')
        assert.deepEqual(sent, ['before'])
        await tx.query('BEGIN')
        afterCommit(tx, one.id, () => { sent.push('invalid') })
        await assert.rejects(tx.query('SELECT 1/0'))
        assert.equal((await tx.query('COMMIT')).command, 'ROLLBACK')
        assert.deepEqual(sent, ['before'])
      } finally { tx.release() }
    })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
