import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq } from 'drizzle-orm'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import * as workspaceSchema from '../lib/db/workspace-schema'
import { organizationEntitlements, organizationMembers, organizationWorkspaces, organizations, workspaceEntitlements } from '../lib/db/governance-schema'
import { activeHumanSeats, assertActiveHumanAdmission, lockWorkspaceEntitlements } from '../lib/governance/entitlements'
import { GovernanceError } from '../lib/governance/errors'
import { enqueueMemberLifecycle } from '../lib/governance/member-outbox'
import { acquireWorkspaceMembership } from '../lib/workspace-membership-guard'
import { readGovernanceLease } from '../lib/governance/lease'
import { acquireHostedQuota } from '../lib/governance/hosted-quota'
import { HostedUsageStore } from '../lib/abuse/store'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('real PostgreSQL serializes seats across acceptance, restoration and organizations', { skip: !url, timeout: 120_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const name = `governance_seats_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${name}`
  const pool = new Pool({ connectionString: target.toString(), max: 10 })
  const quotaPool = new Pool({ connectionString: target.toString(), max: 5 })
  const db = drizzle(pool, { schema: workspaceSchema })
  try {
    await pool.query(`CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY,"userId" text NOT NULL,name varchar(120) NOT NULL,slug varchar(64) UNIQUE,icon text,kind text NOT NULL DEFAULT 'team',"createdAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE mikka_workspace_members ("workspaceId" uuid NOT NULL,"userId" text NOT NULL,name text NOT NULL,email text NOT NULL,role text NOT NULL,status text NOT NULL DEFAULT 'active',"createdAt" timestamptz NOT NULL DEFAULT now(),PRIMARY KEY("workspaceId","userId"));
      CREATE TABLE mikka_workspace_invitations (id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL,"userId" text NOT NULL,email text NOT NULL,role text NOT NULL,"tokenHash" text NOT NULL UNIQUE,status text NOT NULL DEFAULT 'pending',"expiresAt" timestamptz NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now(),UNIQUE("workspaceId",email));`)
    const legacyPersonal = randomUUID()
    await pool.query(`insert into mikka_workspaces(id,"userId",name,kind) values($1,'legacy-owner','Legacy','personal');`, [legacyPersonal])
    await pool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,'legacy-peer','Legacy','legacy@example.invalid','member')`, [legacyPersonal])
    await pool.query(await readFile(new URL('../drizzle/20261107051000_governance.sql', import.meta.url), 'utf8'))
    assert.equal((await pool.query('select status from mikka_workspace_members where "workspaceId"=$1', [legacyPersonal])).rows[0].status, 'suspended')
    await assert.rejects(pool.query('update mikka_workspace_members set status=\'active\' where "workspaceId"=$1', [legacyPersonal]), /only its owner/)
    const workspace = async (members: number, kind: 'personal' | 'team' = 'team') => {
      const id = randomUUID()
      await db.insert(workspaceSchema.workspaces).values({ id, userId: 'human-0', name: 'Seat fixture', kind })
      for (let i = 0; i < members; i++) await db.insert(workspaceSchema.workspaceMembers).values({ workspaceId: id, userId: `human-${i}`, name: `Person ${i}`, email: `p${i}@example.invalid`, role: i === 0 ? 'admin' : 'member' })
      return id
    }
    const admit = (workspaceId: string, userId: string, mode: 'cloud' | 'selfhost' = 'cloud', restore = false) => db.transaction(async tx => {
      await assertActiveHumanAdmission(tx, workspaceId, userId, mode)
      if (restore) await tx.update(workspaceSchema.workspaceMembers).set({ status: 'active' }).where(and(eq(workspaceSchema.workspaceMembers.workspaceId, workspaceId), eq(workspaceSchema.workspaceMembers.userId, userId)))
      else await tx.insert(workspaceSchema.workspaceMembers).values({ workspaceId, userId, name: userId, email: `${userId}@example.invalid`, role: 'member' })
    })

    await t.test('two accepts competing for the fifth seat leave exactly five humans', async () => {
      const id = await workspace(4)
      const outcomes = await Promise.allSettled([admit(id, 'candidate-a'), admit(id, 'candidate-b')])
      assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
      const denied = outcomes.find(value => value.status === 'rejected') as PromiseRejectedResult
      assert.ok(denied.reason instanceof GovernanceError)
      assert.equal(denied.reason.detail, 'seat_limit')
      assert.equal((await db.transaction(tx => activeHumanSeats(tx, id, null))).length, 5)
    })

    await t.test('pending invitations and suspended humans consume no seat; restoration does', async () => {
      const id = await workspace(4)
      await db.insert(workspaceSchema.workspaceMembers).values({ workspaceId: id, userId: 'suspended', name: 'Suspended', email: 's@example.invalid', role: 'member', status: 'suspended' })
      for (let i = 0; i < 10; i++) await db.insert(workspaceSchema.workspaceInvitations).values({ id: randomUUID(), workspaceId: id, userId: 'human-0', email: `${i}@invite.invalid`, role: 'member', tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60000) })
      const outcomes = await Promise.allSettled([admit(id, 'suspended', 'cloud', true), admit(id, 'accepted')])
      assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
      assert.equal((await db.transaction(tx => activeHumanSeats(tx, id, null))).length, 5)
    })

    await t.test('organization counts a human once and serializes admissions to different workspaces', async () => {
      const first = await workspace(4), second = await workspace(4), organizationId = randomUUID()
      await db.insert(organizations).values({ id: organizationId, name: 'Organization', createdBy: 'human-0' })
      await db.insert(organizationEntitlements).values({ organizationId })
      await db.insert(organizationWorkspaces).values([{ workspaceId: first, organizationId }, { workspaceId: second, organizationId }])
      assert.equal((await db.transaction(tx => activeHumanSeats(tx, first, organizationId))).length, 4)
      const outcomes = await Promise.allSettled([admit(first, 'new-a'), admit(second, 'new-b')])
      assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1)
      const winner = outcomes[0].status === 'fulfilled' ? 'new-a' : 'new-b'
      await admit(outcomes[0].status === 'fulfilled' ? second : first, winner)
      assert.equal((await db.transaction(tx => activeHumanSeats(tx, first, organizationId))).length, 5)
    })

    await t.test('community is not capped; expired grants block new seats without deleting old ones', async () => {
      const id = await workspace(7)
      await admit(id, 'community-new', 'selfhost')
      await db.insert(workspaceEntitlements).values({ workspaceId: id, plan: 'pro', source: 'cloud', seatLimit: 20, expiresAt: new Date(Date.now() + 60000) })
      await admit(id, 'paid-new')
      await db.update(workspaceEntitlements).set({ expiresAt: new Date(0) }).where(eq(workspaceEntitlements.workspaceId, id))
      await assert.rejects(admit(id, 'expired-new'), (error: unknown) => error instanceof GovernanceError && error.detail === 'seat_limit')
      assert.equal((await db.transaction(tx => activeHumanSeats(tx, id, null))).length, 9)
      await db.transaction(tx => assertActiveHumanAdmission(tx, id, 'paid-new', 'cloud'))
      assert.equal((await db.transaction(tx => lockWorkspaceEntitlements(tx, id, 'cloud'))).entitlements.plan, 'free')
    })

    await t.test('organization ownership and a paid plan never grant workspace read access', async () => {
      const id = await workspace(1), organizationId = randomUUID()
      await db.insert(organizations).values({ id: organizationId, name: 'Isolated', createdBy: 'organization-admin' })
      await db.insert(organizationMembers).values({ organizationId, userId: 'organization-admin', name: 'Admin', email: 'admin@example.invalid', role: 'owner' })
      await db.insert(organizationEntitlements).values({ organizationId, plan: 'enterprise', source: 'cloud' })
      await db.insert(organizationWorkspaces).values({ workspaceId: id, organizationId })
      await assert.rejects(readGovernanceLease(pool, id, 'organization-admin'), (error: unknown) => error instanceof GovernanceError && error.detail === 'access_denied')
      await db.insert(organizationMembers).values({ organizationId, userId: 'suspended-org-member', name: 'Suspended', email: 'suspended@example.invalid', role: 'member', status: 'suspended' })
      await assert.rejects(admit(id, 'suspended-org-member'), (error: unknown) => error instanceof GovernanceError && error.detail === 'access_denied')
    })

    await t.test('the plan lease takes workspace before membership, so a concurrent suspension does not deadlock', async () => {
      const id = await workspace(1), writer = await pool.connect()
      let observed!: () => void
      const waitingForWorkspace = new Promise<void>(resolve => { observed = resolve })
      const instrumented = { connect: async () => {
        const client = await quotaPool.connect()
        return new Proxy(client, { get(target, property) {
          if (property === 'query') return (...args: unknown[]) => {
            const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? ''
            const result = Reflect.apply(target.query, target, args)
            if (text.includes('from mikka_workspaces') && text.includes('for share')) observed()
            return result
          }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        } })
      } }
      try {
        await writer.query('begin')
        await writer.query("set local lock_timeout='2s'")
        await writer.query('select id from mikka_workspaces where id=$1 for update', [id])
        const pending = acquireWorkspaceMembership(instrumented, { workspaceId: id, userId: 'human-0', pinWorkspace: true })
        const refused = assert.rejects(pending, /Workspace membership/)
        await waitingForWorkspace
        await writer.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=\'human-0\'', [id])
        await writer.query('commit')
        await refused
      } finally { await writer.query('rollback'); writer.release() }
    })

    await t.test('real hosted reservations enforce Pro quota without credit grants or double charges', async () => {
      await pool.query(`create table hosted_verifications ("workspaceId" uuid primary key);
        create table hosted_allowances ("workspaceId" uuid primary key,remaining bigint not null);
        create table workspace_credit_grants (id uuid primary key,"workspaceId" uuid,points integer,bucket text);
        create table bots (id uuid primary key,"workspaceId" uuid);
        create table coordinator_events (id uuid primary key,"botId" uuid,kind text,payload jsonb);
        create table hosted_usage (id text primary key,"workspaceId" uuid,model text,state text,"holdMicroUsd" bigint default 0,
          "reservedUnpaid" bigint default 0,"unpaidMicroUsd" bigint default 0,"reservedFree" bigint default 0,"reservedPurchased" bigint default 0,
          "costMicroUsd" bigint,"freeMicroUsd" bigint default 0,"purchasedMicroUsd" bigint default 0,"inputTokens" bigint default 0,"outputTokens" bigint default 0,
          "generationId" text,"createdAt" timestamptz default now(),"settledAt" timestamptz);`)
      const id = await workspace(1)
      await db.insert(workspaceEntitlements).values({ workspaceId: id, plan: 'pro', source: 'cloud', seatLimit: 20 })
      await pool.query('insert into hosted_verifications values($1)', [id])
      await pool.query('insert into workspace_credit_grants values($1,$2,1000,\'purchased\')', [randomUUID(), id])
      const store = new HostedUsageStore(pool, workspaceId => acquireHostedQuota(workspaceId, quotaPool, 'cloud'))
      const calls = Array.from({ length: 33 }, () => randomUUID())
      const outcomes = await Promise.allSettled(calls.map(call => store.reserve(id, 'fixture', call)))
      assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 32)
      for (const value of outcomes) if (value.status === 'rejected') assert.match(String(value.reason), /usage_concurrency_limit/)
      assert.equal((await store.balance(id)).purchased, 10_000_000, 'a plan and concurrency hold never grant or debit credits')
      assert.equal((await store.status(id)).state, 'usage_concurrency_limit')
      await db.transaction(async tx => {
        await lockWorkspaceEntitlements(tx, id, 'cloud')
        await tx.update(workspaceEntitlements).set({ plan: 'free' }).where(eq(workspaceEntitlements.workspaceId, id))
      })
      await assert.rejects(store.reserve(id, 'fixture', randomUUID()), /usage_concurrency_limit/)
      const admitted = calls.filter((_, i) => outcomes[i].status === 'fulfilled')
      await store.settle(admitted[0], 11)
      await store.settle(admitted[0], 11)
      assert.equal((await store.balance(id)).purchased, 9_999_989, 'actual cost settles exactly once')
      assert.equal((await pool.query('select count(*)::int as n from workspace_credit_grants where "workspaceId"=$1', [id])).rows[0].n, 1)
    })

    await t.test('personal owner and workspace classification are enforced below the application', async () => {
      const id = await workspace(1, 'personal')
      await assert.rejects(admit(id, 'peer', 'selfhost'))
      await assert.rejects(pool.query('update mikka_workspaces set kind=\'team\' where id=$1', [id]), /immutable/)
      await assert.rejects(pool.query('update mikka_workspaces set "userId"=\'other-owner\' where id=$1', [id]), /immutable/)
      await assert.rejects(pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values($1,\'peer\',\'peer\',\'peer\',\'member\',\'suspended\')', [id]), /only its owner/)
    })

    await t.test('member lifecycle work is durable in the same transaction and disappears on rollback', async () => {
      const id = await workspace(1)
      await assert.rejects(db.transaction(async tx => { await enqueueMemberLifecycle(tx, id, 'human-0', 'suspend'); throw new Error('rollback') }), /rollback/)
      assert.equal((await pool.query('select count(*)::int as n from mikka_governance_member_outbox')).rows[0].n, 0)
      await db.transaction(tx => enqueueMemberLifecycle(tx, id, 'human-0', 'suspend'))
      assert.equal((await pool.query('select count(*)::int as n from mikka_governance_member_outbox where "deliveredAt" is null')).rows[0].n, 1)
    })
  } finally {
    await dropTestDatabase(admin, name, pool, quotaPool)
    await admin.end()
  }
})
