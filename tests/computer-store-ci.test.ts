import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq } from 'drizzle-orm'
import * as schema from '../lib/db/workspace-schema'
import { createComputerRequestStore } from '../lib/cua/store-core'
import { createComputerPolicy } from '../lib/cua/policy-core'
import { desktopFingerprint } from '../lib/cua/operation'
import { prepareComputerRequest } from '../lib/cua/broker'

// Never run this test locally. Both writes and cleanup are restricted to the
// workflow's ephemeral PG17 mikka_e2e instance; each run owns its own schema.
test('CI PG17 actual store: owner scope, admin policy, approved claim race, revocation and cancellation', async () => {
  assert.equal(process.env.CI, 'true')
  const target = new URL(process.env.E2E_DATABASE_URL!)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/mikka_e2e')
  const namespace = `cua_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target.toString(), max: 1 })
  assert.equal(Math.floor(Number((await admin.query('show server_version_num')).rows[0].server_version_num) / 10000), 17)
  await admin.query(`create schema "${namespace}"`)
  const pool = new Pool({ connectionString: target.toString(), options: `-c search_path=${namespace}`, max: 5 })
  try {
    await pool.query(`create table mikka_workspaces (id uuid primary key, "userId" text not null, name varchar(120) not null, slug varchar(64), "createdAt" timestamptz not null default now()); create table mikka_workspace_members ("workspaceId" uuid, "userId" text, name text, email text, role text, status text default 'active', "createdAt" timestamptz default now(), primary key ("workspaceId", "userId"));`)
    for (const file of ['20261023185539_computer_requests.sql', '20261023185540_computer_live_approval.sql']) {
      const migration = await readFile(new URL(`../drizzle/${file}`, import.meta.url), 'utf8')
      await pool.query(migration); await pool.query(migration)
    }
    const db = drizzle(pool, { schema })
    // Same active-membership + workspace-row lock contract as requireWorkspace.
    // Deliberately injected instead of importing Next/auth/cookie runtime.
    const requireWorkspace: typeof import('../lib/workspace-access').requireWorkspace = async (tx, id, user, adminOnly = false) => {
      const [row] = await tx.select({ workspace: schema.workspaces, membership: schema.workspaceMembers }).from(schema.workspaces).innerJoin(schema.workspaceMembers, eq(schema.workspaceMembers.workspaceId, schema.workspaces.id)).where(and(eq(schema.workspaces.id, id), eq(schema.workspaceMembers.userId, user), eq(schema.workspaceMembers.status, 'active'))).for('update').limit(1)
      if (!row || adminOnly && row.membership.role !== 'admin') throw new Error('Workspace access denied')
      return row
    }
    const store = createComputerRequestStore(db, requireWorkspace)
    const policy = createComputerPolicy(db, requireWorkspace)
    const workspaceId = randomUUID(), session = randomUUID()
    const config = { workspaceId, token: 'ci-non-secret-fixture', url: 'http://127.0.0.1:3211' }, targetHash = desktopFingerprint(config)
    await db.insert(schema.workspaces).values({ id: workspaceId, userId: 'owner', name: 'CUA CI fixture' })
    await db.insert(schema.workspaceMembers).values(['owner', 'member'].map(userId => ({ workspaceId, userId, name: userId, email: `${userId}@example.com`, role: userId === 'owner' ? 'admin' as const : 'member' as const })))
    assert.equal(await policy.workspaceComputerAccess('owner', config), 'ask')
    await assert.rejects(policy.setWorkspaceComputerAccess('member', workspaceId, 'allow'))
    await assert.rejects(policy.workspaceComputerAccess('outsider', config))
    const prepare = () => prepareComputerRequest(store, 'owner', session, config, { tool: 'screenshot' })
    const one = await prepare()
    for (const [user, sid, fingerprint] of [['other', session, targetHash], ['owner', randomUUID(), targetHash], ['owner', session, 'rotated']]) assert.equal(await store.approve(one.requestId, user, sid, fingerprint, new Date()), null)
    assert.ok(await store.approve(one.requestId, 'owner', session, targetHash, new Date()))
    const claims = await Promise.all([1, 2].map(() => store.consume(one.requestId, 'owner', session, targetHash, new Date(), 'executing')))
    assert.equal(claims.filter(Boolean).length, 1)
    await store.finish(one.requestId, 'complete')
    assert.equal(await store.approve(one.requestId, 'owner', session, targetHash, new Date()), null)
    const denied = await prepare()
    await store.approve(denied.requestId, 'owner', session, targetHash, new Date())
    await policy.setWorkspaceComputerAccess('owner', workspaceId, 'deny')
    assert.equal(await store.consume(denied.requestId, 'owner', session, targetHash, new Date(), 'executing'), null)
    assert.equal((await store.read(denied.requestId, 'owner', session, targetHash))?.status, 'denied')
    await assert.rejects(prepare())
    await policy.setWorkspaceComputerAccess('owner', workspaceId, 'ask')
    const cancelled = await prepare()
    await store.approve(cancelled.requestId, 'owner', session, targetHash, new Date())
    await store.cancel(cancelled.requestId, 'owner', session)
    assert.equal(await store.consume(cancelled.requestId, 'owner', session, targetHash, new Date(), 'executing'), null)
    const removed = await prepare()
    await store.approve(removed.requestId, 'owner', session, targetHash, new Date())
    await db.update(schema.workspaceMembers).set({ status: 'suspended' }).where(eq(schema.workspaceMembers.userId, 'owner'))
    await assert.rejects(store.consume(removed.requestId, 'owner', session, targetHash, new Date(), 'executing'))
    assert.equal((await store.read(removed.requestId, 'owner', session, targetHash))?.status, 'approved')
  } finally { await pool.end(); await admin.query(`drop schema "${namespace}" cascade`); await admin.end() }
})
