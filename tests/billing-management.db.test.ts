// Real PostgreSQL and actual API handlers. Only the external cookie-session adapter
// is supplied by the fixture; PAT verification, ACLs, budgets, audit and ledgers are real.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'
import type { BillingManagementView } from '../lib/billing/management-contract'

let actor: string | null = null
mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async (options: { query?: { disableCookieCache?: boolean } }) => {
  assert.equal(options.query?.disableCookieCache, true)
  return actor ? { user: { id: actor, name: actor, email: `${actor}@example.invalid` }, session: { id: 'billing-http-fixture' } } : null
} } } } })

test('billing management HTTP preserves independent tenants, owners and immutable receipts', { skip: !dbUrl, timeout: 120_000 }, async t => {
  const priorEdition = process.env.MIKKA_EDITION
  process.env.MIKKA_EDITION = 'cloud'
  const [{ pool }, { workspacePool }, workspace, organization, { withBillingAuthority }, { createLegacyPersonalAccessToken }] = await Promise.all([
    import('../lib/db'), import('../lib/workspace-db'), import('../app/api/workspaces/[workspaceId]/billing/route'),
    import('../app/api/organizations/[organizationId]/billing/route'), import('../lib/billing/authority'), import('../lib/tokens/store'),
  ])
  // Proves no nested pool checkout is hidden in a read or financial authority lease.
  pool.options.max = 1; workspacePool.options.max = 1
  const owner = await seedUser(pool, 'billing-ui-owner'), member = await seedUser(pool, 'billing-ui-member')
  const admin = await seedUser(pool, 'billing-ui-admin'), outsider = await seedUser(pool, 'billing-ui-outsider')
  const first = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }, { userId: admin, role: 'admin' }])
  const second = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const foreign = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
  const organizationId = randomUUID(), otherOrganizationId = randomUUID()
  await pool.query('insert into mikka_organizations(id,name,"createdBy") values($1,\'Organization billing\',$3),($2,\'Foreign organization\',$4)', [organizationId, otherOrganizationId, owner, outsider])
  await pool.query(`insert into mikka_organization_members("organizationId","userId",role,name,email) values
    ($1,$2,'owner','Owner','owner@example.invalid'),($1,$3,'admin','Admin','admin@example.invalid'),($1,$4,'member','Member','member@example.invalid'),
    ($5,$6,'owner','Outsider','outsider@example.invalid')`, [organizationId, owner, admin, member, otherOrganizationId, outsider])
  await pool.query('insert into mikka_organization_workspaces("organizationId","workspaceId") values($1,$2),($1,$3),($4,$5)', [organizationId, first.id, second.id, otherOrganizationId, foreign.id])
  const ids = [first.id, second.id, foreign.id]
  const request = (kind: 'workspace' | 'organization', id: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, query = '') => new Request(
    `https://mikka.test/api/${kind === 'workspace' ? 'workspaces' : 'organizations'}/${id}/billing${query}`,
    { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const get = (id = first.id, headers?: Record<string, string>, query = '') => workspace.GET(request('workspace', id, 'GET', undefined, headers, query), { params: Promise.resolve({ workspaceId: id }) })
  const post = (body: unknown, id = first.id, headers?: Record<string, string>) => workspace.POST(request('workspace', id, 'POST', body, headers), { params: Promise.resolve({ workspaceId: id }) })
  const orgGet = (id = organizationId, headers?: Record<string, string>) => organization.GET(request('organization', id, 'GET', undefined, headers), { params: Promise.resolve({ organizationId: id }) })
  const orgPost = (body: unknown) => organization.POST(request('organization', organizationId, 'POST', body), { params: Promise.resolve({ organizationId }) })
  t.after(async () => {
    actor = null
    if (priorEdition === undefined) delete process.env.MIKKA_EDITION; else process.env.MIKKA_EDITION = priorEdition
    // These identifiers belong only to this isolated fixture. No provider resource is created.
    await pool.query('delete from mikka_organization_billing_accounts where "organizationId"=$1', [organizationId])
    await pool.query('delete from agent_runs where "workspaceId"=any($1::uuid[])', [ids])
    await pool.query('delete from agents where "userId"=any($1::text[])', [[owner, member, admin, outsider]])
    for (const table of ['hosted_usage', 'billing_resource_budgets', 'workspace_credit_grants', 'workspace_credit_shares', 'workspace_billing', 'personal_access_tokens'])
      await pool.query(`delete from ${table} where "workspaceId"=any($1::uuid[])`, [ids])
    await pool.query('delete from mikka_organizations where id=any($1::uuid[])', [[organizationId, otherOrganizationId]])
    await pool.query('delete from mikka_workspaces where id=any($1::uuid[])', [ids])
    await pool.query('delete from "user" where id=any($1::text[])', [[owner, member, admin, outsider]])
    await Promise.all([pool.end(), workspacePool.end()])
  })

  await t.test('fresh session, membership, Organization role and request origins gate actual handlers', async () => {
    assert.equal((await get()).status, 401)
    actor = member; assert.equal((await get()).status, 403); assert.equal((await orgGet()).status, 403)
    actor = outsider; assert.equal((await get()).status, 403); assert.equal((await orgGet()).status, 403)
    actor = owner
    const response = await get(), data = await response.json() as BillingManagementView
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(data.organizations.map(row => row.id), [organizationId])
    assert.equal((await orgGet(otherOrganizationId)).status, 403)
    assert.equal((await post({ action: 'account', workspaceId: first.id }, first.id, { origin: 'https://untrusted.example' })).status, 403)
    assert.equal((await get(first.id, {}, `?budgetWorkspace=${foreign.id}`)).status, 403)
    assert.equal((await post({ action: 'account', workspaceId: foreign.id })).status, 403)
    const malformed = new Request(`https://mikka.test/api/workspaces/${first.id}/billing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    assert.equal((await workspace.POST(malformed, { params: Promise.resolve({ workspaceId: first.id }) })).status, 400)
  })

  await t.test('only the Organization owner designates an attached account; admins without Workspace authority only read metadata', async () => {
    actor = admin
    assert.equal((await orgPost({ action: 'account', workspaceId: first.id })).status, 403)
    actor = owner
    await pool.query(`insert into workspace_credit_grants(id,"workspaceId",bucket,points,reason,"externalId") values($1,$2,'purchased',1000,'purchase',$3)`, [randomUUID(), first.id, `billing-ui:${randomUUID()}`])
    assert.equal((await orgPost({ action: 'account', workspaceId: second.id })).status, 200)
    const balanceBefore = (await pool.query('select id,points,"workspaceId" from workspace_credit_grants where "workspaceId"=$1', [first.id])).rows
    actor = admin
    const view = await (await orgGet()).json() as BillingManagementView
    assert.equal(view.account?.workspaceId, second.id); assert.equal(view.canManagePayments, false); assert.equal(view.canManageRecharge, false)
    assert.equal(view.organization?.canDesignate, false)
    assert.equal((await orgPost({ action: 'checkout', accountWorkspaceId: second.id })).status, 403)
    assert.equal((await orgPost({ action: 'budget', workspaceId: second.id, budget: { scope: 'workspace', scopeId: second.id, period: 'month', limitPoints: 10 } })).status, 403)
    actor = owner
    assert.equal((await orgPost({ action: 'account', workspaceId: first.id })).status, 200)
    assert.deepEqual((await pool.query('select id,points,"workspaceId" from workspace_credit_grants where "workspaceId"=$1', [first.id])).rows, balanceBefore)
    const child = await (await get(second.id)).json() as BillingManagementView
    assert.equal(child.account?.workspaceId, second.id); assert.equal(child.platformAccountWorkspaceId, first.id); assert.equal(child.canPurchasePlatform, false)
    assert.equal((await post({ action: 'topup', amount: 10, locale: 'en', accountWorkspaceId: second.id }, second.id)).status, 409)
    assert.equal((await orgPost({ action: 'recharge', accountWorkspaceId: second.id, policy: {} })).status, 409)
  })

  await t.test('member budgets include confirmed spend and unknown holds, with zero/removal and immutable audit', async () => {
    actor = owner
    const call = randomUUID(), held = randomUUID()
    await pool.query(`insert into hosted_usage(id,"workspaceId","usageWorkspaceId","actorId",model,state,"costMicroUsd","holdMicroUsd","freeMicroUsd","purchasedMicroUsd") values
      ($1,$2,$2,$3,'synthetic-platform','settled',2500000,0,0,2500000),($4,$2,$2,$3,'synthetic-platform','unknown',null,400000,0,0)`, [call, first.id, member, held])
    const budget = { scope: 'member', scopeId: member, period: 'month', limitPoints: 300, warningPercent: 80 }
    assert.equal((await post({ action: 'budget', workspaceId: first.id, budget })).status, 200)
    const view = await (await get()).json() as BillingManagementView, row = view.budgets.find(item => item.scope === 'member')!
    assert.deepEqual([row.spentPoints, row.reservedPoints, row.remainingPoints, row.thresholdReached, row.exhausted], [250, 40, 10, true, false])
    assert.deepEqual([view.usage.costMicroUsd, view.usage.reservedMicroUsd, view.usage.unknownCalls], [2500000, 400000, 1])
    assert.equal((await post({ action: 'budget', workspaceId: first.id, budget: { ...budget, limitPoints: 0 } })).status, 200)
    assert.equal((await (await get()).json()).budgets[0].exhausted, true)
    assert.equal((await post({ action: 'budget', workspaceId: first.id, budget: { ...budget, scopeId: outsider } })).status, 403)
    await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [first.id, member])
    assert.equal((await post({ action: 'budget', workspaceId: first.id, budget: { ...budget, limitPoints: null } })).status, 200, 'an obsolete member limit can be removed without resurrecting their membership')
    assert.equal((await pool.query('select count(*)::int n from hosted_usage where id=any($1::text[])', [[call, held]])).rows[0].n, 2)
    assert.equal((await pool.query(`select count(*)::int n from workspace_audit_events where "workspaceId"=$1 and action='billing.limits_changed'`, [first.id])).rows[0].n, 3)
    const unavailable = await post({ action: 'budget', workspaceId: first.id, budget: { ...budget, scope: 'project', scopeId: randomUUID() } })
    assert.equal(unavailable.status, view.resourceTargetsAvailable ? 403 : 409)
    await pool.query('update mikka_workspace_members set status=\'active\' where "workspaceId"=$1 and "userId"=$2', [first.id, member])
  })

  await t.test('external costs are explicitly unknown and private execution content is absent from billing metadata', async () => {
    const agentId = await seedAgent(pool, owner), runId = await seedRun(pool, { userId: owner, agentId, workspaceId: first.id })
    const privateMarker = `private-session-${randomUUID()}`
    await pool.query('update agent_runs set "agentDefinition"=$2::jsonb where id=$1', [runId, JSON.stringify({ systemPrompt: privateMarker, executionIdentity: { version: 2,
      billingAccount: { model: { kind: 'subscription', amount: 'provider_unknown', credentialReference: privateMarker }, runtime: { kind: 'e2b', amount: 'provider_unknown' } } } })])
    actor = admin
    const response = await orgGet(), text = await response.text(), data = JSON.parse(text) as BillingManagementView
    assert.equal(response.status, 200); assert.equal(data.usage.externalUnknownRuns, 1)
    assert.ok(!text.includes(privateMarker) && !text.includes('systemPrompt') && !text.includes('credentialReference'))
    assert.equal(data.usage.costMicroUsd, 2500000, 'external unknown costs never become hosted charges')
    await pool.query('update mikka_organization_members set status=\'suspended\' where "organizationId"=$1 and "userId"=$2', [organizationId, admin])
    assert.equal((await orgGet()).status, 403)
    await pool.query('update mikka_organization_members set status=\'active\' where "organizationId"=$1 and "userId"=$2', [organizationId, admin])
  })

  await t.test('active capacity includes existing grants without relabeling unpaid Stripe state', async () => {
    actor = owner
    await pool.query(`insert into mikka_workspace_entitlements("workspaceId",plan,source) values($1,'enterprise','cloud')
      on conflict ("workspaceId") do update set plan='enterprise',source='cloud',"expiresAt"=null`, [first.id])
    const view = await (await orgGet()).json() as BillingManagementView
    assert.deepEqual(view.capacity, { plan: 'enterprise', hostedMaxInFlight: 128, activeHumanLimit: null })
    assert.equal(view.billing?.entitlementPlan, 'free')
    assert.equal(view.billing?.live, false)
  })

  await t.test('an inactive historical personal credit share remains revocable while the Organization pays', async () => {
    const { creditShareView, setOwnCreditShare } = await import('../lib/credit-shares')
    await pool.query('insert into workspace_credit_shares("workspaceId","userId") values($1,$2)', [first.id, member])
    const existing = await creditShareView(member, first.id)
    assert.deepEqual([existing.mine, existing.canShare], [true, false])
    assert.equal((await setOwnCreditShare(member, first.id, false)).mine, false)
    await assert.rejects(setOwnCreditShare(member, first.id, true), /billingOrganizationAccountRequired/)
    assert.equal((await pool.query('select count(*)::int n from workspace_credit_shares where "workspaceId"=$1 and "userId"=$2', [first.id, member])).rows[0].n, 0)
  })

  await t.test('real scoped PATs cannot enumerate Organizations, cross tenants or survive expiry/revocation', async () => {
    const token = await createLegacyPersonalAccessToken(owner, first.id, { name: 'Billing acceptance', expiresAt: null })
    const headers = { authorization: `Bearer ${token.token}` }
    actor = null
    const read = await get(first.id, headers), data = await read.json() as BillingManagementView
    assert.equal(read.status, 200); assert.deepEqual(data.organizations, []); assert.equal(data.organization, null)
    assert.equal((await get(second.id, headers)).status, 403); assert.equal((await orgGet(organizationId, headers)).status, 403)
    // Expired now, but still a valid lifecycle: creation precedes expiry.
    await pool.query('update personal_access_tokens set "createdAt"=now()-interval \'2 seconds\',"expiresAt"=now()-interval \'1 second\' where id=$1', [token.id])
    assert.equal((await get(first.id, headers)).status, 401)
    await pool.query('update personal_access_tokens set "expiresAt"=null,"revokedAt"=now() where id=$1', [token.id])
    assert.equal((await get(first.id, headers)).status, 401)
  })

  await t.test('payment authority pins the designated payer and serializes Workspace removal through provider work', async () => {
    const { Pool } = await import('pg'), independent = new Pool({ connectionString: dbUrl, max: 1 })
    try {
      await withBillingAuthority(owner, first.id, async () => {
        assert.equal(await withBillingAuthority(owner, first.id, async () => true, { ownPlatformAccount: true }), true)
        const client = await independent.connect()
        try {
          await client.query('begin')
          await assert.rejects(client.query('select id from mikka_workspaces where id=$1 for update nowait', [first.id]), (error: unknown) => (error as { code: string }).code === '55P03')
        } finally { await client.query('rollback'); client.release() }
      }, { organizationId, ownPlatformAccount: true })
      let called = false
      await assert.rejects(withBillingAuthority(owner, second.id, async () => { called = true }, { organizationId, ownPlatformAccount: true }))
      assert.equal(called, false)
      await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [first.id, owner])
      await assert.rejects(withBillingAuthority(owner, first.id, async () => { called = true }, { organizationId, ownPlatformAccount: true }))
      assert.equal(called, false)
      await pool.query('update mikka_workspace_members set status=\'active\' where "workspaceId"=$1 and "userId"=$2', [first.id, owner])
    } finally { await independent.end() }
  })
})
