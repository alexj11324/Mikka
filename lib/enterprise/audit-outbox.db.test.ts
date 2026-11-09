import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
if (target) { assertE2eTarget(target); assert.equal(process.env.MIKKA_DATABASE_URL, target); assert.equal(process.env.DATABASE_URL, target) }
if (!target && process.env.REQUIRE_DB === '1') throw new Error('Identity audit delivery requires the isolated E2E database')

async function bounded<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('audit_pool_barrier_timeout')), 5000)
    work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
async function until(ready: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!await ready()) {
    assert.ok(Date.now() < deadline, 'the real pool wait must become observable')
    await delay(10)
  }
}

test('identity audit delivery releases APP before WS and survives concurrent or failed acknowledgements', { skip: !target, timeout: 60_000 }, async t => {
  const [{ pool }, { workspacePool }, { enqueueIdentityAudit, deliverIdentityAudits }] = await Promise.all([
    import('../db'), import('../workspace-db'), import('./audit-outbox'),
  ])
  assert.notEqual(pool, workspacePool, 'exercise the two production pools even when fixture URLs share a database')
  const previousAppMax = pool.options.max, previousWorkspaceMax = workspacePool.options.max
  pool.options.max = 1; workspacePool.options.max = 1
  const setup = new Pool({ connectionString: target, max: 2 })
  const organizationId = randomUUID(), userId = `audit-delivery-${randomUUID()}`
  await setup.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
  await setup.query('insert into mikka_organizations (id,name,"createdBy") values ($1,\'Audit delivery fixture\',$2)', [organizationId, userId])
  const count = async (eventId: string) => Number((await setup.query('select count(*) from mikka_organization_audit_events where id=$1 and "organizationId"=$2', [eventId, organizationId])).rows[0].count)
  const intent = async () => {
    const id = randomUUID(), tx = await pool.connect()
    try {
      await tx.query('begin')
      await enqueueIdentityAudit(tx, { eventId: id, organizationId, actorId: userId, action: 'sso.policy_changed', targetId: id,
        metadata: { enabled: true, reason: 'fixture' } })
      await tx.query('commit')
    } catch (error) { await tx.query('rollback'); throw error } finally { tx.release() }
    return id
  }
  try {
    await t.test('a waiting WS receipt leaves the real APP max1 connection available to a WS-first writer', async () => {
      const id = await intent(), held = await workspacePool.connect()
      const delivery = deliverIdentityAudits(organizationId)
      // Attach a rejection handler immediately, including the failure-cleanup path.
      const settled = delivery.then(value => ({ value }), error => ({ error }))
      try {
        await until(() => workspacePool.waitingCount === 1)
        assert.equal(pool.totalCount, 1)
        assert.equal(workspacePool.totalCount, 1)
        const probe = await bounded(pool.query('select 1 as ready'))
        assert.equal(probe.rows[0].ready, 1, 'a WS lease can still acquire APP while the receipt waits for WS')
        assert.equal((await setup.query('select "deliveredAt",payload,"lastAttemptAt" from enterprise_audit_outbox where id=$1', [id])).rows[0].deliveredAt, null)
      } finally { held.release(); await bounded(settled) }
      assert.deepEqual(await delivery, { delivered: 1, failed: 0 })
      assert.equal(await count(id), 1)
    })
    await t.test('concurrent forced claims insert one stable WS event and acknowledge it once', async () => {
      const id = await intent(), held = await workspacePool.connect()
      const deliveries = [deliverIdentityAudits(organizationId), deliverIdentityAudits(organizationId)]
      const settled = Promise.allSettled(deliveries)
      try {
        await until(() => workspacePool.waitingCount === 2)
        assert.equal((await bounded(pool.query('select 1 as ready'))).rows[0].ready, 1)
      } finally { held.release(); await bounded(settled) }
      const results = await Promise.all(deliveries)
      assert.equal(results.reduce((sum, result) => sum + result.delivered, 0), 1)
      assert.equal(results.reduce((sum, result) => sum + result.failed, 0), 0)
      assert.equal(await count(id), 1)
      assert.equal((await setup.query('select payload from enterprise_audit_outbox where id=$1 and "deliveredAt" is not null', [id])).rows[0].payload, null)
    })
    await t.test('WS failure keeps the intent retryable after the existing bounded retry delay', async () => {
      const id = await intent(), name = `audit_ws_failure_${randomUUID().replaceAll('-', '')}`
      await setup.query(`alter table mikka_organization_audit_events add constraint "${name}" check (id<>'${id}'::uuid) not valid`)
      try {
        assert.deepEqual(await deliverIdentityAudits(organizationId), { delivered: 0, failed: 1 })
        const pending = (await setup.query('select payload,"deliveredAt","lastAttemptAt" from enterprise_audit_outbox where id=$1', [id])).rows[0]
        assert.equal(pending.payload.id, id); assert.equal(pending.deliveredAt, null); assert.ok(pending.lastAttemptAt)
        assert.deepEqual(await deliverIdentityAudits(organizationId, false), { delivered: 0, failed: 0 }, 'maintenance respects its existing retry spacing')
        assert.equal(await count(id), 0)
      } finally { await setup.query(`alter table mikka_organization_audit_events drop constraint "${name}"`) }
      await setup.query('update enterprise_audit_outbox set "lastAttemptAt"=now()-interval \'31 seconds\' where id=$1', [id])
      assert.deepEqual(await deliverIdentityAudits(organizationId, false), { delivered: 1, failed: 0 }, 'a claim is not a permanent lease or a lost intent')
      assert.equal(await count(id), 1)
    })
    await t.test('a failed APP ack after WS commit retains the payload and retries without a second receipt', async () => {
      const id = await intent(), name = `audit_ack_failure_${randomUUID().replaceAll('-', '')}`
      await setup.query(`create function "${name}"() returns trigger language plpgsql as $$ begin
        if new.id='${id}'::uuid and new."deliveredAt" is not null then raise exception 'fixture_ack_refused' using errcode='23514'; end if;
        return new;
      end $$;`)
      await setup.query(`create trigger "${name}" before update of "deliveredAt" on enterprise_audit_outbox for each row execute function "${name}"()`)
      try {
        await assert.rejects(deliverIdentityAudits(organizationId), error => (error as { code?: string }).code === '23514')
        assert.equal(await count(id), 1, 'the WS receipt committed before acknowledgement')
        const pending = (await setup.query('select payload,"deliveredAt" from enterprise_audit_outbox where id=$1', [id])).rows[0]
        assert.equal(pending.payload.id, id); assert.equal(pending.deliveredAt, null)
      } finally {
        await setup.query(`drop trigger "${name}" on enterprise_audit_outbox`)
        await setup.query(`drop function "${name}"()`)
      }
      assert.deepEqual(await deliverIdentityAudits(organizationId), { delivered: 1, failed: 0 })
      assert.equal(await count(id), 1)
      assert.deepEqual(await deliverIdentityAudits(organizationId), { delivered: 0, failed: 0 })
    })
  } finally {
    await setup.query('delete from enterprise_audit_outbox where "organizationId"=$1', [organizationId])
    await setup.query('delete from mikka_organization_audit_events where "organizationId"=$1', [organizationId])
    await setup.query('delete from mikka_organizations where id=$1', [organizationId])
    await setup.query('delete from "user" where id=$1', [userId])
    pool.options.max = previousAppMax; workspacePool.options.max = previousWorkspaceMax
    await Promise.all([setup.end(), pool.end(), workspacePool.end()])
  }
})
