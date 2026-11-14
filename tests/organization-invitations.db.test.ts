import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { eq, and } from 'drizzle-orm'
import { assertE2eTarget } from './helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw new Error('Org invitation acceptance requires isolated PG17')

test('Organization invitations grant only a verified Member without inheriting Workspace ACL', { skip: !target, timeout: 120_000 }, async t => {
  const previousEdition = process.env.MIKKA_EDITION
  process.env.MIKKA_EDITION = 'cloud'
  t.after(() => { if (previousEdition === undefined) delete process.env.MIKKA_EDITION; else process.env.MIKKA_EDITION = previousEdition })
  const check = new Pool({ connectionString: target, max: 2 })
  const { workspaceDb, workspacePool } = await import('../lib/workspace-db')
  const { pool: appPool } = await import('../lib/db')
  const { organizationMembers, organizationInvitations, organizationWorkspaces } = await import('../lib/db/governance-schema')
  const { workspaceMembers } = await import('../lib/db/workspace-schema')
  const organization = await import('../lib/governance/organizations')
  const invite = await import('../lib/governance/organization-invitations')

  const owner = { id: randomUUID(), name: 'Org owner', email: randomUUID() + '@org.example.invalid' }
  const sender = { id: randomUUID(), name: 'Org member', email: randomUUID() + '@org.example.invalid' }
  const other = { id: randomUUID(), name: 'Other member', email: randomUUID() + '@org.example.invalid' }
  const invitee = { id: randomUUID(), name: 'Verified invitee', email: randomUUID() + '@org.example.invalid' }
  const unverified = { id: randomUUID(), name: 'Unverified invitee', email: randomUUID() + '@org.example.invalid' }
  const outsider = { id: randomUUID(), name: 'Outsider', email: randomUUID() + '@org.example.invalid' }
  const people = [owner, sender, other, invitee, unverified, outsider]
  for (const user of people) await check.query(
    'insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,$4,now(),now())',
    [user.id, user.name, user.email, user.id !== unverified.id])
  let organizationId = ''
  let secondOrganizationId = ''
  const workspaceId = randomUUID()
  const secondWorkspaceId = randomUUID()
  t.after(async () => {
    if (organizationId) await check.query('delete from mikka_organizations where id=$1', [organizationId])
    if (secondOrganizationId) await check.query('delete from mikka_organizations where id=$1', [secondOrganizationId])
    for (const id of [workspaceId, secondWorkspaceId]) {
      await check.query('delete from mikka_workspace_members where "workspaceId"=$1', [id])
      await check.query('delete from mikka_workspaces where id=$1', [id])
    }
    for (const user of people) await check.query('delete from "user" where id=$1', [user.id])
  })
  t.after(async () => { await Promise.all([check.end(), workspacePool.end(), appPool.end()]) })
  organizationId = (await organization.createOrganization(owner, { name: 'Member-only invitation test' })).id
  secondOrganizationId = (await organization.createOrganization(outsider, { name: 'Independent org' })).id
  await organization.addOrganizationMember(organizationId, owner.id, { userId: sender.id, role: 'member' })
  await organization.addOrganizationMember(organizationId, owner.id, { userId: other.id, role: 'member' })
  await check.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,$3,$4)',
    [workspaceId, owner.id, 'Private shared workspace', 'team'])
  await check.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role) values ($1,$2,$3,$4,$5)',
    [workspaceId, owner.id, owner.name, owner.email, 'admin'])
  await check.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,$3,$4)',
    [secondWorkspaceId, outsider.id, 'Second org private workspace', 'team'])
  await check.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role) values ($1,$2,$3,$4,$5)',
    [secondWorkspaceId, outsider.id, outsider.name, outsider.email, 'admin'])
  await workspaceDb.insert(organizationWorkspaces).values([
    { organizationId, workspaceId },
    { organizationId: secondOrganizationId, workspaceId: secondWorkspaceId },
  ])

  await t.test('any member can issue only Member links; duplicate and pending do not rotate the bearer', async () => {
    await assert.rejects(invite.issueOrganizationInvitations(organizationId, outsider.id, { emails: [invitee.email] }),
      (error: unknown) => (error as { detail?: string }).detail === 'access_denied')
    await assert.rejects(invite.issueOrganizationInvitations(organizationId, sender.id, { emails: [invitee.email], role: 'admin' }))
    const first = await invite.issueOrganizationInvitations(organizationId, sender.id, {
      emails: [invitee.email.toUpperCase(), invitee.email, owner.email],
    })
    assert.deepEqual(first.outcomes.map(row => row.created), [true, false, false])
    assert.equal(first.outcomes[1].created ? '' : first.outcomes[1].reason, 'duplicate')
    assert.equal(first.outcomes[2].created ? '' : first.outcomes[2].reason, 'alreadyMember')
    assert.match(first.outcomes[0].created ? first.outcomes[0].path : '', /^\/organization-invite\/[a-f0-9]{64}$/)
    const pending = await invite.issueOrganizationInvitations(organizationId, other.id, { emails: [invitee.email] })
    assert.equal(pending.outcomes[0].created ? '' : pending.outcomes[0].reason, 'pending')
    const ours = await invite.listOrganizationInvitations(organizationId, sender.id)
    const theirs = await invite.listOrganizationInvitations(organizationId, other.id)
    assert.equal(ours.invitations.length, 1)
    assert.equal(theirs.invitations.length, 0, 'a normal member cannot enumerate other senders pending emails')
  })

  await t.test('acceptance requires matching verified email and is single-use under concurrency', async () => {
    const original = await invite.issueOrganizationInvitations(organizationId, sender.id, { emails: [unverified.email] })
    const token = original.outcomes[0].created ? original.outcomes[0].path.split('/').at(-1)! : ''
    await assert.rejects(invite.listReceivedOrganizationInvitations(unverified), { detail: 'access_denied' })
    await assert.rejects(invite.acceptOrganizationInvitation({ token }, unverified),
      (error: unknown) => (error as { detail?: string }).detail === 'access_denied')
    const denied = await invite.issueOrganizationInvitations(organizationId, sender.id, { emails: [invitee.email] })
    assert.equal(denied.outcomes[0].created, false)
    const [row] = await workspaceDb.select({ tokenHash: organizationInvitations.tokenHash }).from(organizationInvitations)
      .where(and(eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.email, invitee.email)))
    assert.match(row.tokenHash, /^[a-f0-9]{64}$/, 'database stores only the digest')
    // Revoke then reissue a new bearer so this test never needs to read a plaintext token from storage.
    const [first] = await workspaceDb.select({ id: organizationInvitations.id }).from(organizationInvitations)
      .where(and(eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.email, invitee.email)))
    await assert.rejects(invite.revokeOrganizationInvitation(organizationId, other.id, { invitationId: first.id }),
      (error: unknown) => (error as { detail?: string }).detail === 'access_denied')
    await invite.revokeOrganizationInvitation(organizationId, sender.id, { invitationId: first.id })
    const fresh = await invite.issueOrganizationInvitations(organizationId, sender.id, { emails: [invitee.email] })
    const newToken = fresh.outcomes[0].created ? fresh.outcomes[0].path.split('/').at(-1)! : ''
    assert.ok(newToken)
    const received = (await invite.listReceivedOrganizationInvitations(invitee)).invitations
    assert.deepEqual(received.map(row => row.id), [first.id])
    assert.equal(received[0].organizationName, 'Member-only invitation test')
    assert.deepEqual(Object.keys(received[0]).sort(), ['expiresAt', 'id', 'organizationName'])
    assert.deepEqual((await invite.listReceivedOrganizationInvitations(outsider)).invitations, [])
    await assert.rejects(invite.listReceivedOrganizationInvitations({ ...outsider, email: invitee.email }), { detail: 'access_denied' })
    await assert.rejects(invite.acceptOrganizationInvitation({ invitationId: first.id }, outsider), { detail: 'invalid_request' })
    await assert.rejects(invite.acceptOrganizationInvitation({ token: newToken }, outsider),
      (error: unknown) => (error as { detail?: string }).detail === 'invalid_request')
    const before = await workspaceDb.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))
    const beforeSecond = await workspaceDb.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, secondWorkspaceId))
    const attempts = await Promise.allSettled([
      invite.acceptOrganizationInvitation({ invitationId: first.id }, invitee),
      invite.acceptOrganizationInvitation({ token: newToken }, invitee),
    ])
    assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1)
    assert.equal(attempts.filter(row => row.status === 'rejected').length, 1)
    assert.deepEqual((await invite.listReceivedOrganizationInvitations(invitee)).invitations, [])
    const [member] = await workspaceDb.select().from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, invitee.id)))
    assert.equal(member.role, 'member')
    assert.equal(member.status, 'active')
    assert.equal((await workspaceDb.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))).length,
      before.length, 'joining an Organization must not create Workspace membership')
    assert.equal((await workspaceDb.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, secondWorkspaceId))).length,
      beforeSecond.length, 'joining the first Organization must not grant access to the second private Workspace')
    assert.equal((await workspaceDb.select().from(organizationMembers).where(and(
      eq(organizationMembers.organizationId, secondOrganizationId), eq(organizationMembers.userId, invitee.id)))).length, 0)
    await assert.rejects(invite.acceptOrganizationInvitation({ token: newToken }, invitee))
  })

  await t.test('two Organizations keep member invitations separate from both private Workspace ACLs', async () => {
    // "other" belongs to the first Organization, but neither private Workspace.
    const invitation = await invite.issueOrganizationInvitations(secondOrganizationId, outsider.id, { emails: [other.email] })
    const outcome = invitation.outcomes[0]
    if (!outcome.created) throw new Error('second Organization fixture invitation not created')
    const firstOrgBefore = await workspaceDb.select({ role: organizationMembers.role }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, other.id)))
    assert.equal(firstOrgBefore.length, 1)
    const result = await invite.acceptOrganizationInvitation({ token: outcome.path.split('/').at(-1)! }, other)
    assert.equal(result.organizationId, secondOrganizationId)
    assert.equal(result.role, 'member')
    const firstOrgAfter = await workspaceDb.select({ role: organizationMembers.role }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, other.id)))
    assert.deepEqual(firstOrgAfter, firstOrgBefore, 'second Organization membership must not replace the first')
    for (const id of [workspaceId, secondWorkspaceId]) {
      const unauthorized = await workspaceDb.select().from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, other.id)))
      assert.equal(unauthorized.length, 0, 'accepting either Organization invitation must not confer a private Workspace role')
    }
    const isolated = await invite.listOrganizationInvitations(secondOrganizationId, other.id)
    assert.deepEqual(isolated.invitations, [], 'a newly invited Member cannot enumerate the second Organization owner\'s invites')
    await assert.rejects(invite.issueOrganizationInvitations(secondOrganizationId, sender.id, { emails: [invitee.email] }),
      (error: unknown) => (error as { detail?: string }).detail === 'access_denied')
    // An Organization owner must not revoke an invitation from another
    // Organization even when given the exact UUID of its pending invitation.
    const otherOrgPending = await invite.issueOrganizationInvitations(secondOrganizationId, outsider.id, {
      emails: [unverified.email],
    })
    const pending = otherOrgPending.outcomes[0]
    if (!pending.created) throw new Error('independent Organization fixture invitation not created')
    await assert.rejects(invite.revokeOrganizationInvitation(organizationId, owner.id, { invitationId: pending.id }),
      (error: unknown) => (error as { detail?: string }).detail === 'access_denied')
    const [unmodified] = await workspaceDb.select({ status: organizationInvitations.status }).from(organizationInvitations)
      .where(eq(organizationInvitations.id, pending.id))
    assert.equal(unmodified.status, 'pending', 'cross-Organization revocation must not mutate the invitation')
    await invite.revokeOrganizationInvitation(secondOrganizationId, outsider.id, { invitationId: pending.id })
  })

  await t.test('revoked and expired bearers never reactivate, and members can only revoke their own invites', async () => {
    const first = await invite.issueOrganizationInvitations(organizationId, other.id, { emails: [outsider.email] })
    const issued = first.outcomes[0]
    assert.equal(issued.created, true)
    if (!issued.created) throw new Error('fixture link not created')
    await assert.rejects(invite.revokeOrganizationInvitation(organizationId, sender.id, { invitationId: issued.id }))
    await invite.revokeOrganizationInvitation(organizationId, owner.id, { invitationId: issued.id })
    await assert.rejects(invite.acceptOrganizationInvitation({ token: issued.path.split('/').at(-1)! }, outsider))
    const expired = await invite.issueOrganizationInvitations(organizationId, other.id, { emails: [outsider.email] })
    if (!expired.outcomes[0].created) throw new Error('fixture retry not created')
    // The same invitation row ID is reused. Reissuing it must still invalidate
    // the previously revoked bearer while the new invitation remains pending.
    await assert.rejects(invite.acceptOrganizationInvitation({ token: issued.path.split('/').at(-1)! }, outsider),
      (error: unknown) => (error as { detail?: string }).detail === 'invalid_request')
    const [reissued] = await workspaceDb.select({ status: organizationInvitations.status }).from(organizationInvitations)
      .where(eq(organizationInvitations.id, expired.outcomes[0].id))
    assert.equal(reissued.status, 'pending', 'a rejected old bearer must not consume its replacement')
    await workspaceDb.update(organizationInvitations).set({ expiresAt: new Date(0) })
      .where(eq(organizationInvitations.id, expired.outcomes[0].id))
    assert.deepEqual((await invite.listReceivedOrganizationInvitations(outsider)).invitations, [])
    await assert.rejects(invite.acceptOrganizationInvitation({ invitationId: expired.outcomes[0].id }, outsider), { detail: 'invalid_request' })
    await assert.rejects(invite.acceptOrganizationInvitation({
      token: expired.outcomes[0].path.split('/').at(-1)!,
    }, outsider))
  })

  await t.test('an invitation issued by a suspended member cannot be accepted', async () => {
    const issued = await invite.issueOrganizationInvitations(organizationId, other.id, { emails: [outsider.email] })
    const record = issued.outcomes[0]
    if (!record.created) throw new Error('fixture invitation missing')
    await workspaceDb.update(organizationMembers).set({ status: 'suspended' })
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, other.id)))
    assert.deepEqual((await invite.listReceivedOrganizationInvitations(outsider)).invitations, [])
    await assert.rejects(invite.acceptOrganizationInvitation({ token: record.path.split('/').at(-1)! }, outsider))
    await workspaceDb.update(organizationMembers).set({ status: 'active' })
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, other.id)))
    await invite.revokeOrganizationInvitation(organizationId, owner.id, { invitationId: record.id })
  })

  await t.test('removing a sender revokes outstanding links without opening the recipient workspace', async () => {
    const sent = await invite.issueOrganizationInvitations(organizationId, sender.id, { emails: [outsider.email] })
    const record = sent.outcomes[0]
    if (!record.created) throw new Error('the expired invitation must be reissued before removal')
    await organization.removeOrganizationMember(organizationId, owner.id, sender.id)
    const [state] = await workspaceDb.select({ status: organizationInvitations.status }).from(organizationInvitations)
      .where(eq(organizationInvitations.id, record.id))
    assert.equal(state.status, 'revoked')
    await assert.rejects(invite.acceptOrganizationInvitation({ token: record.path.split('/').at(-1)! }, outsider))
    assert.equal((await workspaceDb.select().from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, outsider.id)))).length, 0)
  })

  const [active] = await workspaceDb.select({ role: organizationMembers.role }).from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, invitee.id)))
  assert.equal(active.role, 'member')
  assert.equal((await check.query('select count(*)::integer as n from mikka_workspace_members where "userId"=$1',
    [invitee.id])).rows[0].n, 0)
})
