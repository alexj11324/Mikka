import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

/*
 * 我的点数也可用于这个团队 against real Postgres (decision 2026-10-31-2300 item 4):
 * a member shares their personal credits with a team; the team's own balance
 * pays first, then sharers' balances, oldest share first; leaving or a
 * suspension ends it; a personal workspace cannot take shares.
 */
test('credit shares: opt in, pay order, leave, scope', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const { hostedUsage } = await import('../lib/abuse/runtime')
  const shares = await import('../lib/credit-shares')
  const { releaseDepartingMember } = await import('../lib/workspace-admin/members')

  const owner = await seedUser(pool, 'share-owner'), member = await seedUser(pool, 'share-member'), second = await seedUser(pool, 'share-second'), outsider = await seedUser(pool, 'share-outsider')
  const team = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }, { userId: second, role: 'member' }])
  const personal = async (userId: string) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO mikka_workspaces (id,"userId",name,slug,kind) VALUES ($1,$2,'personal',$3,'personal')`, [id, userId, `p-${id.slice(0, 8)}`])
    await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role) VALUES ($1,$2,$2,$3,'admin')`, [id, userId, `${userId}@example.invalid`])
    return id
  }
  const memberOwn = await personal(member), secondOwn = await personal(second)
  // Each verified a card: USD 1 on their personal workspace.
  await hostedUsage.verify(memberOwn, null, null)
  await hostedUsage.verify(secondOwn, null, null)
  const admit = (workspaceId: string) => shares.withSharedCredits(workspaceId, async payer => { await hostedUsage.canUseMikkaPaid(payer); return payer })
  const reserve = (workspaceId: string) => shares.withSharedCredits(workspaceId, async payer => { await hostedUsage.reserve(payer, 'test-model', randomUUID()); return payer })

  await t.test('without a share the team\'s own refusal stands', async () => {
    await assert.rejects(admit(team.id), { code: 'verification_required' })
    assert.deepEqual(await shares.creditShareView(member, team.id), { mine: false, canShare: true, sharers: [], admin: false })
  })

  await t.test('a member opts in: the team spends their personal balance; admins see who', async () => {
    assert.equal((await shares.setOwnCreditShare(member, team.id, true)).mine, true)
    await shares.setOwnCreditShare(second, team.id, true)
    assert.deepEqual((await shares.creditShareView(owner, team.id)).sharers, ['share-member', 'share-second'], 'oldest share first, names only for admins')
    assert.deepEqual((await shares.creditShareView(second, team.id)).sharers, [])
    assert.equal(await admit(team.id), memberOwn)
    const payer = await reserve(team.id)
    assert.equal(payer, memberOwn)
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM hosted_usage WHERE "workspaceId"=$1`, [memberOwn])).rows[0].n, 1, 'the call is charged to the sharer\'s workspace')
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM hosted_usage WHERE "workspaceId"=$1`, [team.id])).rows[0].n, 0)
  })

  await t.test('the next sharer pays when the first one runs out', async () => {
    await pool.query('UPDATE hosted_allowances SET remaining=0 WHERE "workspaceId"=$1', [memberOwn])
    await pool.query(`UPDATE hosted_usage SET state='settled' WHERE "workspaceId"=$1`, [memberOwn]).catch(() => {})
    assert.equal(await admit(team.id), secondOwn)
  })

  await t.test('the team\'s own balance pays first', async () => {
    await hostedUsage.verify(team.id, null, null)
    assert.equal(await admit(team.id), team.id)
    await pool.query('UPDATE hosted_allowances SET remaining=0 WHERE "workspaceId"=$1', [team.id])
  })

  await t.test('stopping, a suspension or leaving ends a share at once', async () => {
    await shares.setOwnCreditShare(second, team.id, false)
    assert.deepEqual(await shares.sharedCreditWorkspaces(team.id), [memberOwn])
    await shares.setOwnCreditShare(second, team.id, true)
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [team.id, second])
    assert.deepEqual(await shares.sharedCreditWorkspaces(team.id), [memberOwn], 'a suspended member\'s credits do not pay')
    await releaseDepartingMember(team.id, member)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM workspace_credit_shares WHERE "workspaceId"=$1 AND "userId"=$2', [team.id, member])).rows[0].n, 0)
    await assert.rejects(admit(team.id), { code: 'free_allowance_used' })
  })

  await t.test('a personal workspace takes no shares; an outsider sees nothing', async () => {
    await assert.rejects(shares.setOwnCreditShare(member, memberOwn, true), { code: 'validationGeneric' })
    assert.equal((await shares.creditShareView(member, memberOwn)).canShare, false)
    await assert.rejects(shares.creditShareView(outsider, team.id), { code: 'workspaceAccessDenied' })
    await assert.rejects(shares.setOwnCreditShare(outsider, team.id, true), { code: 'workspaceAccessDenied' })
  })
})
