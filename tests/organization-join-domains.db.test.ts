import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { assertE2eTarget } from './helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw new Error('Domain admission requires isolated PG17')

test('Verified domain admission stays within the chosen Organization', { skip: !target, timeout: 120_000 }, async t => {
  // DNS is the external boundary; grants, authorization and verification persistence use PG17.
  const dnsRecords = new Map<string, string[][]>()
  let dnsError: string | undefined
  t.mock.module('node:dns/promises', { namedExports: { ...await import('node:dns/promises'),
    resolveTxt: async (name: string) => {
      if (dnsError) throw Object.assign(new Error('DNS fixture unavailable'), { code: dnsError })
      return dnsRecords.get(name) ?? []
    },
  } })
  const db = new Pool({ connectionString: target })
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const org = await import('../lib/governance/organizations')
  const domains = await import('../lib/governance/organization-join-domains')
  const domain = `${randomUUID()}.example.org`
  const people = ['owner', 'member', 'visitor', 'unverified', 'public', 'wrong'].map(name => ({
    id: randomUUID(), name, email: `${randomUUID()}@${name === 'public' ? 'gmail.com' : name === 'wrong' ? 'other.example.org' : domain}`,
  }))
  const [owner, member, visitor, unverified, webmail, wrong] = people
  const organizations: string[] = []
  const workspaceId = randomUUID()
  const denied = (error: unknown) => (error as { detail?: string }).detail === 'access_denied'
  t.after(async () => {
    try {
      await db.query('delete from mikka_organizations where id=any($1::uuid[])', [organizations])
      await db.query('delete from mikka_workspaces where id=$1', [workspaceId])
      await db.query('delete from "user" where id=any($1::text[])', [people.map(user => user.id)])
    } finally { await Promise.all([db.end(), pool.end(), workspacePool.end()]) }
  })
  for (const user of people) await db.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,$4,now(),now())', [user.id, user.name, user.email, user !== unverified])
  for (const [user, name] of [[owner, 'A'], [owner, 'B'], [webmail, 'Public'], [unverified, 'Unverified']] as const) organizations.push((await org.createOrganization(user, { name })).id)
  const [a, b, publicOrg, unverifiedOrg] = organizations
  await org.addOrganizationMember(a, owner.id, { userId: member.id })
  await db.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,$3,$4)', [workspaceId, owner.id, 'Private', 'team'])
  await db.query('insert into mikka_organization_workspaces ("organizationId","workspaceId") values ($1,$2)', [a, workspaceId])
  const sessionId = randomUUID()
  let aDomainId = ''
  await t.test('only an admin with the matching verified business domain can add it', async () => {
    await assert.rejects(domains.listAllowedDomains(a, member.id), denied)
    await assert.rejects(domains.addAllowedDomain(a, member, { domain }), denied)
    await assert.rejects(domains.addAllowedDomain(a, owner, { domain: 'other.example.org' }), denied)
    await assert.rejects(domains.addAllowedDomain(publicOrg, webmail, { domain: 'gmail.com' }), denied)
    await assert.rejects(domains.addAllowedDomain(unverifiedOrg, unverified, { domain }), denied)
    await assert.rejects(domains.addAllowedDomain(a, owner, { domain: '*.example.org' }))
    const [one, two] = await Promise.all([domains.addAllowedDomain(a, owner, { domain: domain.toUpperCase() }), domains.addAllowedDomain(a, owner, { domain })])
    assert.deepEqual(one, two)
    aDomainId = one.domain.id
    assert.deepEqual(await domains.listAllowedDomains(a, owner.id), { domains: [one.domain] })
    assert.notEqual((await domains.addAllowedDomain(b, owner, { domain })).domain.id, aDomainId)
  })
  await t.test('the grant receipt survives audit retention and removal returns the same scoped rule once', async () => {
    const response = await domains.addAllowedDomain(b, owner, { domain })
    const id = response.domain.id
    const { rows: [event] } = await db.query(
      'select "actorId", "createdAt" from mikka_organization_audit_events where "organizationId"=$1 and "targetId"=$2 and action=$3',
      [b, id, 'organization.join_domain_added'])
    assert.equal(response.domain.createdByUserId, event.actorId)
    assert.equal(response.domain.createdByUserId, owner.id)
    assert.deepEqual(response.domain.createdAt, event.createdAt)
    assert.deepEqual(response.domain.updatedAt, response.domain.createdAt)
    await db.query('delete from mikka_organization_audit_events where "organizationId"=$1 and "targetId"=$2', [b, id])
    assert.deepEqual((await domains.listAllowedDomains(b, owner.id)).domains, [response.domain])
    assert.deepEqual(await domains.removeAllowedDomain(a, id, owner.id), { removed: true, domain: null })
    assert.deepEqual(await domains.removeAllowedDomain(b, id, owner.id), { removed: true, domain: response.domain })
    assert.deepEqual(await domains.removeAllowedDomain(b, id, owner.id), { removed: true, domain: null })
    const replacement = await domains.addAllowedDomain(b, owner, { domain })
    assert.notEqual(replacement.domain.id, id)
  })
  await t.test('DNS proof is scoped to the exact Organization grant, checked fresh, and required for admission', async () => {
    assert.deepEqual(await domains.listJoinableOrganizations(visitor, sessionId), { organizations: [] })
    await assert.rejects(domains.joinOrganizationByDomain(a, visitor, sessionId), denied)
    const ruleA = (await domains.listAllowedDomains(a, owner.id)).domains[0]
    const ruleB = (await domains.listAllowedDomains(b, owner.id)).domains[0]
    await assert.rejects(domains.verifyAllowedDomain(a, ruleA.id, member.id), denied)
    await assert.rejects(domains.verifyAllowedDomain(a, ruleA.id, visitor.id), denied)
    await assert.rejects(domains.verifyAllowedDomain(a, ruleB.id, owner.id), { detail: 'not_found' })
    const missing = await domains.verifyAllowedDomain(a, ruleA.id, owner.id)
    assert.equal(missing.verified, false)
    assert.equal(missing.domain.verificationError, 'record_missing')
    assert.equal(missing.domain.verifiedAt, null)
    assert.ok(missing.domain.lastCheckedAt)
    const aRecord = domains.organizationDomainRecord(a, ruleA)
    const bRecord = domains.organizationDomainRecord(b, ruleB)
    dnsRecords.set(aRecord.name, [[aRecord.value.slice(0, 20), aRecord.value.slice(20)]])
    const verified = await domains.verifyAllowedDomain(a, ruleA.id, owner.id)
    assert.equal(verified.verified, true)
    assert.ok(verified.domain.verifiedAt)
    assert.equal(verified.domain.verificationError, null)
    assert.deepEqual(verified.dns, aRecord)
    assert.equal((await domains.verifyAllowedDomain(b, ruleB.id, owner.id)).verified, false,
      'a DNS proof for one organization cannot authorize another organization')
    dnsError = 'ETIMEOUT'
    const unavailable = await domains.verifyAllowedDomain(a, ruleA.id, owner.id)
    assert.equal(unavailable.domain.verificationError, 'lookup_failed')
    assert.equal(unavailable.domain.verifiedAt, null)
    assert.deepEqual(await domains.listJoinableOrganizations(visitor, sessionId), { organizations: [] })
    dnsError = undefined
    dnsRecords.set(aRecord.name, [[aRecord.value], [bRecord.value]])
    assert.equal((await domains.verifyAllowedDomain(a, ruleA.id, owner.id)).verified, true)
    assert.equal((await domains.verifyAllowedDomain(b, ruleB.id, owner.id)).verified, true)
  })
  await t.test('discover only exact matches and independently choose one organization', async () => {
    assert.deepEqual((await domains.listJoinableOrganizations(visitor, sessionId)).organizations.map(row => row.id), [a, b])
    for (const user of [wrong, unverified, webmail, { ...wrong, email: visitor.email }]) {
      assert.deepEqual(await domains.listJoinableOrganizations(user, sessionId), { organizations: [] })
      await assert.rejects(domains.joinOrganizationByDomain(a, user, sessionId), denied)
    }
    const replies = await Promise.all(Array.from({ length: 2 }, () => domains.joinOrganizationByDomain(a, visitor, sessionId)))
    assert.deepEqual(replies, Array(2).fill({ organizationId: a, joined: true, role: 'member' }))
    assert.equal((await domains.joinOrganizationByDomain(a, owner, sessionId)).role, 'owner')
    assert.deepEqual((await domains.listJoinableOrganizations(visitor, sessionId)).organizations.map(row => row.id), [b])
    assert.equal((await db.query('select 1 from mikka_workspace_members where "userId"=$1 and "workspaceId"=$2', [visitor.id, workspaceId])).rowCount, 0)
    assert.equal((await db.query('select 1 from mikka_organization_audit_events where "actorId"=$1 and action=$2', [visitor.id, 'organization.member_joined_by_domain'])).rowCount, 1)
  })
  await t.test('explicit removal and domain readmission leave private Workspace membership suspended', async () => {
    await db.query('insert into mikka_workspace_members ("workspaceId","userId",role,name,email) values ($1,$2,$3,$4,$5)', [workspaceId, visitor.id, 'member', visitor.name, visitor.email])
    await org.removeOrganizationMember(a, owner.id, visitor.id)
    assert.equal((await org.listOrganizations(visitor.id)).length, 0)
    assert.deepEqual((await domains.listJoinableOrganizations(visitor, sessionId)).organizations.map(row => row.id), [a, b])
    assert.equal((await domains.joinOrganizationByDomain(a, visitor, sessionId)).role, 'member')
    const { rows } = await db.query('select status from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [workspaceId, visitor.id])
    assert.deepEqual(rows, [{ status: 'suspended' }])
  })
  await t.test('SSO and suspension still apply; removal is scoped, idempotent, and preserves members', async () => {
    await db.query('update mikka_organization_members set status=$1 where "organizationId"=$2 and "userId"=$3', ['suspended', a, member.id])
    await assert.rejects(domains.joinOrganizationByDomain(a, member, sessionId), denied)
    await db.query('insert into enterprise_org_policy ("organizationId","enforceSso") values ($1,true)', [b])
    try {
      assert.deepEqual(await domains.listJoinableOrganizations(visitor, sessionId), { organizations: [] })
      await assert.rejects(domains.joinOrganizationByDomain(b, visitor, sessionId), (error: unknown) => (error as { code?: string }).code === 'workspaceAccessDenied')
    } finally { await db.query('delete from enterprise_org_policy where "organizationId"=$1', [b]) }
    await assert.rejects(domains.removeAllowedDomain(a, aDomainId, visitor.id), denied)
    await domains.removeAllowedDomain(b, aDomainId, owner.id)
    assert.equal((await domains.listAllowedDomains(a, owner.id)).domains.length, 1)
    // Queue a new join behind a transaction that withdraws the allow rule; the join must re-read after the lock releases.
    const queued = await db.connect()
    try {
      await queued.query('begin')
      await queued.query('select id from mikka_organizations where id=$1 for update', [a])
      await queued.query('delete from mikka_organization_join_domains where id=$1', [aDomainId])
      const waiting = assert.rejects(domains.joinOrganizationByDomain(a, visitor, sessionId), denied)
      await queued.query('commit')
      await waiting
    } finally { await queued.query('rollback'); queued.release() }
    const { domain: replacement } = await domains.addAllowedDomain(a, owner, { domain })
    await Promise.all([domains.removeAllowedDomain(a, replacement.id, owner.id), domains.removeAllowedDomain(a, replacement.id, owner.id)])
    assert.deepEqual(await domains.listAllowedDomains(a, owner.id), { domains: [] })
    assert.equal((await org.listOrganizations(visitor.id)).some(row => row.id === a), true)
    assert.equal((await domains.listAllowedDomains(b, owner.id)).domains.length, 1)
    await assert.rejects(domains.joinOrganizationByDomain(a, visitor, sessionId), denied)
  })
})
