import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'

test('hosted Checkout verification on isolated PostgreSQL', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const { pool: appPool } = await import('../db')
  const { workspacePool } = await import('../workspace-db')
  const { hostedUsage } = await import('./runtime')
  const { applyCardCheckout, applyCardSetup, cardVerificationStatus, workspaceCardStatus } = await import('./card')
  const old = { secret: process.env.STRIPE_SECRET_KEY, webhook: process.env.STRIPE_WEBHOOK_SECRET }
  process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture'
  t.after(async () => {
    if (old.secret === undefined) delete process.env.STRIPE_SECRET_KEY
    else process.env.STRIPE_SECRET_KEY = old.secret
    if (old.webhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET
    else process.env.STRIPE_WEBHOOK_SECRET = old.webhook
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const owner = await seedUser(pool, 'verify-owner'), member = await seedUser(pool, 'verify-member')
  const workspace = () => seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const fingerprint = `card_${randomUUID()}`
  const create = async (workspaceId: string, card = fingerprint, last4 = '4242') => {
    const id = randomUUID().replaceAll('-', '')
    const session = { id: `cs_${id}`, customer: `cus_${id}`, mode: 'setup', status: 'complete', setup_intent: `seti_${id}`, metadata: { workspaceId: 'untrusted' } }
    const intent = { id: session.setup_intent, customer: session.customer, status: 'succeeded', payment_method: `pm_${id}` }
    await pool.query('INSERT INTO hosted_setup_intents (id,"workspaceId","customerId") VALUES ($1,$2,$3)', [session.id, workspaceId, session.customer])
    const fake = (async (url: string) => Response.json(url.includes('/setup_intents/') ? intent : { type: 'card', customer: session.customer, card: { fingerprint: card, last4 } })) as typeof fetch
    return { session, intent, fake }
  }
  const auditCount = async (id: string) => Number((await pool.query('SELECT count(*) AS n FROM workspace_audit_events WHERE "workspaceId"=$1 AND action=\'billing.card_verified\'', [id])).rows[0].n)

  await t.test('completion and legacy duplicates verify, claim, grant and audit once', async () => {
    const ws = await workspace(), setup = await create(ws.id)
    await Promise.all([applyCardCheckout(setup.session, setup.fake), applyCardCheckout(setup.session, setup.fake)])
    await pool.query('INSERT INTO hosted_setup_intents (id,"workspaceId","customerId") VALUES ($1,$2,$3)', [setup.intent.id, ws.id, setup.intent.customer])
    await applyCardSetup(setup.intent, setup.fake)
    assert.equal(await auditCount(ws.id), 1)
    assert.equal((await pool.query('SELECT * FROM hosted_card_claims WHERE fingerprint=$1', [fingerprint])).rows[0].workspaceId, ws.id)
    assert.deepEqual(await workspaceCardStatus(ws.id), { status: 'verified', last4: '4242', allowance: 'granted', remainingAllowanceMicroUsd: 1_000_000, remainingAllowancePoints: 100 })
    await pool.query('UPDATE hosted_allowances SET remaining=0 WHERE "workspaceId"=$1', [ws.id])
    assert.equal((await workspaceCardStatus(ws.id)).allowance, 'granted')
    assert.equal((await workspaceCardStatus(ws.id)).remainingAllowancePoints, 0)
    const replacementFingerprint = `card_${randomUUID()}`
    const replacement = await create(ws.id, replacementFingerprint, '1111')
    await applyCardCheckout(replacement.session, replacement.fake)
    await applyCardCheckout(setup.session, setup.fake)
    assert.equal((await workspaceCardStatus(ws.id)).last4, '4242')
    assert.equal((await workspaceCardStatus(ws.id)).remainingAllowancePoints, 0)
    assert.equal(await auditCount(ws.id), 1)
    assert.equal((await pool.query('SELECT "workspaceId" FROM hosted_card_claims WHERE fingerprint=$1', [fingerprint])).rows[0].workspaceId, ws.id, 'old claims remain owned by their original workspace')
    assert.equal((await pool.query('SELECT * FROM hosted_card_claims WHERE fingerprint=$1', [replacementFingerprint])).rowCount, 0, 'complete verification records are replay no-ops')
  })

  await t.test('same card in a second workspace verifies without a second allowance', async () => {
    const ws = await workspace(), setup = await create(ws.id)
    await applyCardCheckout(setup.session, setup.fake)
    assert.deepEqual(await workspaceCardStatus(ws.id), { status: 'verified', last4: '4242', allowance: 'claimed_elsewhere', remainingAllowanceMicroUsd: 0, remainingAllowancePoints: 0 })
    assert.equal(await auditCount(ws.id), 1)
    assert.equal((await pool.query('SELECT metadata FROM workspace_audit_events WHERE "workspaceId"=$1 AND action=\'billing.card_verified\'', [ws.id])).rows[0].metadata.allowanceGranted, false)
  })

  await t.test('old verified workspace stores newly verified card without granting or auditing twice', async () => {
    const ws = await workspace()
    await hostedUsage.verify(ws.id, null, null)
    const setup = await create(ws.id, `card_${randomUUID()}`, '1234')
    await pool.query('UPDATE hosted_allowances SET remaining=250000 WHERE "workspaceId"=$1', [ws.id])
    await applyCardCheckout(setup.session, setup.fake)
    const different = await create(ws.id, `card_${randomUUID()}`, '9999')
    await applyCardCheckout(different.session, different.fake)
    await applyCardCheckout(setup.session, setup.fake)
    await hostedUsage.verify(ws.id, null, null)
    assert.deepEqual(await workspaceCardStatus(ws.id), { status: 'verified', last4: '1234', allowance: 'granted', remainingAllowanceMicroUsd: 250_000, remainingAllowancePoints: 25 })
    assert.equal(await auditCount(ws.id), 1)
    assert.equal((await pool.query('SELECT * FROM hosted_card_claims WHERE "workspaceId"=$1', [ws.id])).rowCount, 1)
  })

  await t.test('old verification with the same card fills missing last4 without resetting its allowance', async () => {
    const ws = await workspace(), card = `card_${randomUUID()}`
    await hostedUsage.verify(ws.id, 'cus_old', card)
    const setup = await create(ws.id, card, '5678')
    await pool.query('UPDATE hosted_allowances SET remaining=100000 WHERE "workspaceId"=$1', [ws.id])
    await applyCardCheckout(setup.session, setup.fake)
    assert.deepEqual(await workspaceCardStatus(ws.id), { status: 'verified', last4: '5678', allowance: 'granted', remainingAllowanceMicroUsd: 100_000, remainingAllowancePoints: 10 })
    assert.equal(await auditCount(ws.id), 1)
  })

  await t.test('status is pending before the webhook, unverified after expiration, unavailable without Stripe', async () => {
    const ws = await workspace()
    assert.equal((await workspaceCardStatus(ws.id)).status, 'unverified')
    const setup = await create(ws.id)
    const sessionState = (status: string) => (async () => Response.json({ customer: setup.session.customer, status })) as typeof fetch
    assert.equal((await workspaceCardStatus(ws.id, sessionState('open'))).status, 'pending')
    assert.equal((await workspaceCardStatus(ws.id, sessionState('complete'))).status, 'pending')
    assert.equal((await workspaceCardStatus(ws.id, sessionState('expired'))).status, 'unverified')
    await pool.query('UPDATE hosted_setup_intents SET "createdAt"=now()-interval \'1 hour\' WHERE id=$1', [setup.session.id])
    const newer = await create(ws.id)
    assert.equal((await workspaceCardStatus(ws.id, (async (url: string) => {
      assert.match(url, new RegExp(`${newer.session.id}$`))
      return Response.json({ customer: newer.session.customer, status: 'expired' })
    }) as typeof fetch)).status, 'unverified', 'the newest setup determines pending status')
    delete process.env.STRIPE_WEBHOOK_SECRET
    assert.equal((await workspaceCardStatus(ws.id)).status, 'unavailable')
    assert.equal((await cardVerificationStatus(member, ws.id)).status, 'unavailable')
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture'
    assert.equal(await auditCount(ws.id), 0, 'status reads never grant')
    assert.equal((await pool.query('SELECT * FROM hosted_verifications WHERE "workspaceId"=$1', [ws.id])).rowCount, 0)
  })

  await t.test('verification is the person\'s: a member reads their own, from a team, and the USD 1 lands in their personal workspace', async () => {
    const team = await workspace()
    const { personalBillingWorkspace } = await import('./card-checkout')
    const personal = await personalBillingWorkspace(member)
    assert.notEqual(personal, team.id)
    assert.equal((await pool.query('SELECT kind FROM mikka_workspaces WHERE id=$1', [personal])).rows[0]?.kind, 'personal')
    assert.equal((await cardVerificationStatus(member, team.id)).status, 'unverified', 'not an admin of the team, still their own status')
    const setup = await create(personal, `card_${randomUUID()}`, '4444')
    await applyCardCheckout(setup.session, setup.fake)
    assert.deepEqual(await cardVerificationStatus(member, team.id), { status: 'verified', last4: '4444', allowance: 'granted', remainingAllowanceMicroUsd: 1_000_000, remainingAllowancePoints: 100 })
    assert.equal((await pool.query('SELECT * FROM hosted_allowances WHERE "workspaceId"=$1', [team.id])).rowCount, 0, 'the team gets no allowance from it')
    // The owner verified cards on workspaces they own before (the subtests above): that counts for their personal workspace too.
    assert.equal((await cardVerificationStatus(owner, team.id)).status, 'verified')
    const outsider = await seedUser(pool, 'verify-outsider')
    await assert.rejects(cardVerificationStatus(outsider, team.id), /workspaceAccessDenied/)
  })
})
