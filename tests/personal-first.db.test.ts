// A person's first workspace is their personal one (decision 2026-11-02-1500):
// creating a team or accepting an invitation makes sure it exists first, so
// nobody has a team without a personal workspace. Real Postgres; only the
// request (signed-in user, cookies, locale) is stubbed.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('personal workspace first', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  let user = { id: '', name: '', email: '' }
  const translate = Object.assign((key: string) => key, { has: () => true })
  mock.module('@/lib/issue-access', { namedExports: { requireUser: async () => user } })
  mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ set() {}, delete() {}, get() {} }) } })
  mock.module('next-intl/server', { namedExports: { getTranslations: async () => translate, getLocale: async () => 'zh-CN' } })
  const actions = await import('../app/actions/workspace')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const signIn = async (label: string) => {
    const id = await seedUser(pool, label)
    user = { id, name: label, email: `${id}@example.invalid` }
    return id
  }
  const kinds = async (userId: string) => (await pool.query<{ kind: string; name: string }>(
    `SELECT w.kind,w.name FROM mikka_workspaces w JOIN mikka_workspace_members m ON m."workspaceId"=w.id WHERE m."userId"=$1 ORDER BY w."createdAt",w.id`, [userId])).rows

  await t.test('creating a team makes the personal workspace first', async () => {
    const id = await signIn('first-team')
    assert.deepEqual(await kinds(id), [])
    const created = await actions.createWorkspace({ name: 'Acme', slug: `acme-${randomUUID().slice(0, 8)}` })
    assert.equal(created.ok, true)
    const rows = await kinds(id)
    assert.deepEqual(rows.map(row => row.kind).sort(), ['personal', 'team'])
    assert.equal(rows.find(row => row.kind === 'personal')?.name, 'first-team 的工作区')
    await actions.createWorkspace({ name: 'Beta', slug: `beta-${randomUUID().slice(0, 8)}` })
    assert.equal((await kinds(id)).filter(row => row.kind === 'personal').length, 1, 'still one personal workspace')
  })

  await t.test('accepting an invitation makes the personal workspace first', async () => {
    const owner = await signIn('first-owner')
    const team = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
    const email = 'first-joiner@example.invalid'
    const invited = await actions.createWorkspaceInvitation({ workspaceId: team.id, emails: [email, email.toUpperCase()], role: 'member' })
    if (!invited.ok) throw new Error('Invitation unexpectedly failed')
    assert.equal(invited.data.length, 1)
    assert.deepEqual(invited.outcomes.map(outcome => [outcome.email, outcome.created ? 'created' : outcome.reason]), [
      [email, 'created'], [email, 'duplicate'],
    ])
    const token = invited.data[0].path.split('/').at(-1)!
    const joiner = await seedUser(pool, 'first-joiner')
    user = { id: joiner, name: 'first-joiner', email: 'first-joiner@example.invalid' }
    assert.equal((await actions.acceptWorkspaceInvitation(token)).ok, true)
    assert.deepEqual((await kinds(joiner)).map(row => row.kind).sort(), ['personal', 'team'])
  })
})
