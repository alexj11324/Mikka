// Personal workspaces (decision 2026-10-31-2130) against a real PostgreSQL:
// the kind backfill on existing data, invited sign-ups, and who pays for work
// with no workspace of its own.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

const uuidFrom = (seed: string) => {
  const hash = createHash('sha256').update(seed).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

test('personal workspaces', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })

  await t.test('the kind migration marks only untouched sign-up workspaces personal, and replays safely', async () => {
    const schema = `personal_${randomUUID().replaceAll('-', '')}`
    await pool.query(`CREATE SCHEMA ${schema}`)
    const scoped = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}`, max: 1 })
    try {
      // The tables as they were before the migration, with existing rows.
      await scoped.query(`CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY, "userId" text NOT NULL, name varchar(120) NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
        CREATE TABLE mikka_workspace_members ("workspaceId" uuid NOT NULL, "userId" text NOT NULL, status text NOT NULL DEFAULT 'active', PRIMARY KEY ("workspaceId","userId"));
        CREATE TABLE mikka_workspace_invitations (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, status text NOT NULL)`)
      const seed = async (user: string, id: string, members: Array<[string, string]>, invite = false) => {
        await scoped.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,$3)', [id, user, user])
        for (const [member, status] of members) await scoped.query('INSERT INTO mikka_workspace_members VALUES ($1,$2,$3)', [id, member, status])
        if (invite) await scoped.query(`INSERT INTO mikka_workspace_invitations VALUES ($1,$2,'pending')`, [randomUUID(), id])
      }
      const alone = uuidFrom('orvilo-default:alone'), grown = uuidFrom('orvilo-default:grown'), inviting = uuidFrom('orvilo-default:inviting')
      const created = randomUUID(), suspended = uuidFrom('orvilo-default:suspended'), accepted = uuidFrom('orvilo-default:accepted')
      await seed('alone', alone, [['alone', 'active']])
      await seed('grown', grown, [['grown', 'active'], ['peer', 'active']])
      await seed('inviting', inviting, [['inviting', 'active']], true)
      await seed('created', created, [['created', 'active']])
      await seed('suspended', suspended, [['suspended', 'suspended']])
      await seed('accepted', accepted, [['accepted', 'active']])
      await scoped.query(`INSERT INTO mikka_workspace_invitations VALUES ($1,$2,'accepted')`, [randomUUID(), accepted])
      const migration = await readFile(new URL('../drizzle/20261031213104_personal_workspace_kind.sql', import.meta.url), 'utf8')
      await scoped.query(migration)
      await scoped.query(migration)
      const kinds = Object.fromEntries((await scoped.query('SELECT id,kind FROM mikka_workspaces')).rows.map(row => [row.id, row.kind]))
      assert.deepEqual(kinds, {
        [alone]: 'personal', [accepted]: 'personal',
        [grown]: 'team', [inviting]: 'team', [created]: 'team', [suspended]: 'team',
      })
      assert.equal((await scoped.query('SELECT count(*)::int AS n FROM mikka_workspaces')).rows[0].n, 6, 'no row added or removed')
      await assert.rejects(scoped.query(`INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,'alone','x','personal')`, [randomUUID()]), { code: '23505' }, 'one personal workspace per person')
      await assert.rejects(scoped.query(`UPDATE mikka_workspaces SET kind='shared' WHERE id=$1`, [grown]), { code: '23514' })
    } finally {
      await scoped.end()
      await pool.query(`DROP SCHEMA ${schema} CASCADE`)
    }
  })

  await t.test('a user whose first workspace came from an invite gets a personal workspace, and background work bills it', async () => {
    const { executionWorkspace } = await import('../lib/execution-settings')
    const owner = await seedUser(pool, 'owner'), invited = await seedUser(pool, 'invited')
    // The team is older than anything the invited user owns: the old rule billed it.
    const team = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: invited, role: 'member' }])
    const personal = await executionWorkspace(invited, null)
    assert.notEqual(personal, team.id, 'never 「the oldest workspace」')
    const { rows: [row] } = await pool.query('SELECT "userId",kind FROM mikka_workspaces WHERE id=$1', [personal])
    assert.deepEqual(row, { userId: invited, kind: 'personal' })
    assert.deepEqual((await pool.query('SELECT "userId",role,status FROM mikka_workspace_members WHERE "workspaceId"=$1', [personal])).rows, [{ userId: invited, role: 'admin', status: 'active' }], 'only that user')
    assert.equal(await executionWorkspace(invited, null), personal, 'created once')
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM mikka_workspaces WHERE "userId"=$1 AND kind='personal'`, [invited])).rows[0].n, 1)
  })

  await t.test('a sign-up workspace that became a team stays a team; its owner gets a second, personal one', async () => {
    const { ensurePersonalWorkspace } = await import('../lib/personal-workspace')
    const owner = await seedUser(pool, 'grown')
    const defaultId = uuidFrom(`orvilo-default:${owner}`)
    await pool.query(`INSERT INTO mikka_workspaces (id,"userId",name,slug) VALUES ($1,$2,'Team',$3)`, [defaultId, owner, `ws-${defaultId.slice(0, 8)}`])
    await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role) VALUES ($1,$2,'o','o@example.invalid','admin')`, [defaultId, owner])
    const personal = await ensurePersonalWorkspace({ id: owner, email: `${owner}@example.invalid`, name: 'grown' }, 'zh-CN')
    assert.equal(personal, uuidFrom(`mikka-personal:${owner}`))
    assert.equal((await pool.query('SELECT kind FROM mikka_workspaces WHERE id=$1', [defaultId])).rows[0].kind, 'team')
    // Concurrent first loads create exactly one.
    const racer = await seedUser(pool, 'racer')
    const ids = await Promise.all(Array.from({ length: 4 }, () => ensurePersonalWorkspace({ id: racer, email: `${racer}@example.invalid`, name: 'racer' }, 'en')))
    assert.equal(new Set(ids).size, 1)
    assert.equal(ids[0], uuidFrom(`orvilo-default:${racer}`), 'a new user keeps the sign-up id')
  })
})
