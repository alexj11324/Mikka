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

  await t.test('only a verified recipient can suppress their invitation email while keeping their pending invitation', async t => {
    const { readPreferences, savePreferences } = await import('../lib/preferences')
    const { sendOrganizationInvitationEmails } = await import('../lib/governance/organization-invitation-mail')
    const mailOrgId = (await organization.createOrganization(owner, { name: 'Invitation email preferences' })).id
    t.after(async () => { await check.query('delete from mikka_organizations where id=$1', [mailOrgId]) })
    const unknownEmail = randomUUID() + '@org.example.invalid'
    const emails = [invitee.email, outsider.email, unverified.email, unknownEmail]
    const sent: string[] = []
    const deliver = async (message: { to: string }) => { sent.push(message.to) }
    const origin = 'https://app.example.test'
    const create = () => invite.issueOrganizationInvitations(mailOrgId, owner.id, { emails })
    const revoke = async (issued: Awaited<ReturnType<typeof create>>) => {
      for (const outcome of issued.outcomes) {
        assert.ok(outcome.created)
        await invite.revokeOrganizationInvitation(mailOrgId, owner.id, { invitationId: outcome.id })
      }
    }
    assert.equal((await readPreferences(invitee.id)).organizationInvitationEmails, true)
    const issued = await create()
    // Change the preference after the issue transaction, before the delivery job runs.
    await savePreferences(invitee.id, { organizationInvitationEmails: false })
    await savePreferences(unverified.id, { organizationInvitationEmails: false })
    assert.deepEqual(await sendOrganizationInvitationEmails(issued.outcomes, origin, deliver), { acceptedByProvider: 3, failed: 0 })
    assert.deepEqual(sent.sort(), [outsider.email, unverified.email, unknownEmail].sort())
    assert.equal((await invite.listReceivedOrganizationInvitations(invitee)).invitations.length, 1)
    assert.equal((await readPreferences(outsider.id)).organizationInvitationEmails, true)
    const duplicates = await create()
    assert.deepEqual(await sendOrganizationInvitationEmails(duplicates.outcomes, origin, deliver), { acceptedByProvider: 0, failed: 0 })
    await revoke(issued)
    await savePreferences(invitee.id, { organizationInvitationEmails: true })
    const reissued = await create()
    sent.length = 0
    assert.deepEqual(await sendOrganizationInvitationEmails(reissued.outcomes, origin, deliver), { acceptedByProvider: 4, failed: 0 })
    assert.deepEqual(sent.sort(), [...emails].sort())
    await revoke(reissued)
  })

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
    assert.equal(received[0].organizationId, organizationId)
    assert.equal(received[0].inviterName, sender.name)
    const [stored] = await workspaceDb.select({ createdAt: organizationInvitations.createdAt })
      .from(organizationInvitations).where(eq(organizationInvitations.id, first.id))
    assert.deepEqual(received[0].invitedAt, stored.createdAt)
    assert.deepEqual(Object.keys(received[0]).sort(), ['expiresAt', 'id', 'invitedAt', 'inviterName', 'organizationId', 'organizationName'])
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

  await t.test('elevated invitations require current org and workspace authority and grant only named teams', async t => {
    const recipients = ['scoped-admin', 'org-admin', 'changed-issuer', 'removed-team', 'suspended-recipient', 'revoked-scope'].map(name => ({
      id: randomUUID(), name, email: `${randomUUID()}@org.example.invalid`,
    }))
    people.push(...recipients)
    for (const user of recipients) await check.query(
      'insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,now(),now())',
      [user.id, user.name, user.email])
    const [scopedAdmin, orgAdmin, changedIssuer, removedTeam, suspendedRecipient, revokedScope] = recipients
    const teamId = randomUUID(), siblingTeamId = randomUUID(), foreignTeamId = randomUUID()
    const teamIds = [teamId, siblingTeamId, foreignTeamId]
    t.after(async () => {
      await check.query('delete from mikka_team_members where "teamId"=any($1::uuid[])', [teamIds])
      await check.query('delete from mikka_teams where id=any($1::uuid[])', [teamIds])
    })
    for (const [id, workspace, creator, identifier] of [[teamId, workspaceId, owner.id, 'NAMED'],
      [siblingTeamId, workspaceId, owner.id, 'PRIVATE'], [foreignTeamId, secondWorkspaceId, outsider.id, 'FOREIGN']]) {
      await check.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,$4,$5)',
        [id, workspace, creator, identifier, identifier])
    }
    const denied = (error: unknown) => (error as { detail?: string }).detail === 'access_denied'
    await assert.rejects(invite.issueOrganizationInvitations(organizationId, other.id,
      { emails: [scopedAdmin.email], role: 'admin' }), denied)
    await assert.rejects(invite.issueOrganizationInvitations(organizationId, other.id,
      { emails: [scopedAdmin.email], teamIds: [teamId] }), denied)
    await assert.rejects(invite.issueOrganizationInvitations(organizationId, outsider.id,
      { emails: [scopedAdmin.email], role: 'admin', teamIds: [teamId] }), denied)
    await assert.rejects(invite.issueOrganizationInvitations(organizationId, owner.id,
      { emails: [scopedAdmin.email], role: 'owner' }))
    await check.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role) values ($1,$2,$3,$4,$5)',
      [secondWorkspaceId, owner.id, owner.name, owner.email, 'admin'])
    try {
      await assert.rejects(invite.issueOrganizationInvitations(organizationId, owner.id,
        { emails: [scopedAdmin.email], teamIds: [foreignTeamId] }), denied)
    } finally {
      await check.query('delete from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [secondWorkspaceId, owner.id])
    }
    async function issue(user: typeof owner, role: 'admin' | 'member', scopes: string[]) {
      const [created] = (await invite.issueOrganizationInvitations(organizationId, owner.id,
        { emails: [user.email], role, teamIds: scopes })).outcomes
      if (!created.created) throw new Error('Scoped invitation fixture was not created')
      return created
    }
    const scoped = await issue(scopedAdmin, 'admin', [teamId, teamId])
    const listed = (await invite.listOrganizationInvitations(organizationId, owner.id)).invitations.find(row => row.id === scoped.id)
    assert.equal(listed?.role, 'admin')
    assert.deepEqual(listed?.teamIds, [teamId])
    assert.deepEqual(await invite.acceptOrganizationInvitation({ invitationId: scoped.id }, scopedAdmin), {
      organizationId, joined: true, role: 'admin', teamIds: [teamId],
    })
    assert.deepEqual((await check.query('select "workspaceId",role from mikka_workspace_members where "userId"=$1',
      [scopedAdmin.id])).rows, [{ workspaceId, role: 'member' }])
    assert.deepEqual((await check.query('select "teamId",role from mikka_team_members where "userId"=$1',
      [scopedAdmin.id])).rows, [{ teamId, role: 'member' }])
    const unscoped = await issue(orgAdmin, 'admin', [])
    assert.equal((await invite.acceptOrganizationInvitation({ invitationId: unscoped.id }, orgAdmin)).role, 'admin')
    assert.equal((await check.query('select 1 from mikka_workspace_members where "userId"=$1', [orgAdmin.id])).rowCount, 0)
    const revoked = await issue(revokedScope, 'admin', [teamId])
    await invite.revokeOrganizationInvitation(organizationId, owner.id, { invitationId: revoked.id })
    await assert.rejects(invite.acceptOrganizationInvitation({ invitationId: revoked.id }, revokedScope))
    const reissued = await issue(revokedScope, 'member', [])
    assert.equal(reissued.id, revoked.id)
    const replacement = (await invite.listOrganizationInvitations(organizationId, owner.id)).invitations.find(row => row.id === reissued.id)
    assert.equal(replacement?.role, 'member')
    assert.deepEqual(replacement?.teamIds, [])
    assert.equal((await invite.acceptOrganizationInvitation({ invitationId: reissued.id }, revokedScope)).role, 'member')
    assert.equal((await check.query('select 1 from mikka_workspace_members where "userId"=$1', [revokedScope.id])).rowCount, 0,
      'reissuing an unscoped invitation cannot retain the revoked team grant')
    const changed = await issue(changedIssuer, 'admin', [teamId])
    await check.query('update mikka_organization_members set role=$1 where "organizationId"=$2 and "userId"=$3',
      ['member', organizationId, owner.id])
    try { await assert.rejects(invite.acceptOrganizationInvitation({ invitationId: changed.id }, changedIssuer)) }
    finally { await check.query('update mikka_organization_members set role=$1 where "organizationId"=$2 and "userId"=$3', ['owner', organizationId, owner.id]) }
    await check.query('update mikka_workspace_members set role=$1 where "workspaceId"=$2 and "userId"=$3', ['member', workspaceId, owner.id])
    try { await assert.rejects(invite.acceptOrganizationInvitation({ invitationId: changed.id }, changedIssuer), denied) }
    finally { await check.query('update mikka_workspace_members set role=$1 where "workspaceId"=$2 and "userId"=$3', ['admin', workspaceId, owner.id]) }
    await check.query('update mikka_teams set "archivedAt"=now() where id=$1', [siblingTeamId])
    await assert.rejects(issue(removedTeam, 'member', [siblingTeamId]), denied)
    await check.query('update mikka_teams set "archivedAt"=null where id=$1', [siblingTeamId])
    const removed = await issue(removedTeam, 'member', [siblingTeamId])
    await check.query('delete from mikka_teams where id=$1', [siblingTeamId])
    await assert.rejects(invite.acceptOrganizationInvitation({ invitationId: removed.id }, removedTeam), denied)
    const suspended = await issue(suspendedRecipient, 'member', [teamId])
    await check.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$3,$4,$5,$6)',
      [workspaceId, suspendedRecipient.id, suspendedRecipient.name, suspendedRecipient.email, 'member', 'suspended'])
    await assert.rejects(invite.acceptOrganizationInvitation({ invitationId: suspended.id }, suspendedRecipient), denied)
    for (const user of [changedIssuer, removedTeam, suspendedRecipient]) {
      assert.equal((await check.query('select 1 from mikka_organization_members where "organizationId"=$1 and "userId"=$2',
        [organizationId, user.id])).rowCount, 0, 'a rejected scoped invitation cannot partially grant organization access')
    }
  })

  const [active] = await workspaceDb.select({ role: organizationMembers.role }).from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, invitee.id)))
  assert.equal(active.role, 'member')
  assert.equal((await check.query('select count(*)::integer as n from mikka_workspace_members where "userId"=$1',
    [invitee.id])).rows[0].n, 0)
})
