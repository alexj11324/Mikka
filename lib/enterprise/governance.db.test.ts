import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { verifyAuditExport } from '../audit/integrity'
import { identityTokenHash } from './scim-store'

const target = process.env.E2E_DATABASE_URL
if (target) { assertE2eTarget(target); assert.equal(process.env.MIKKA_DATABASE_URL, target); assert.equal(process.env.DATABASE_URL, target) }
if (!target && process.env.REQUIRE_DB === '1') throw new Error('Enterprise governance requires the isolated E2E database')

test('Organization CRUD, resource approvals and audit export retain Workspace authorization boundaries', { skip: !target, timeout: 120_000 }, async t => {
  const previousEdition = process.env.MIKKA_EDITION
  process.env.MIKKA_EDITION = 'cloud'
  t.after(() => { if (previousEdition === undefined) delete process.env.MIKKA_EDITION; else process.env.MIKKA_EDITION = previousEdition })
  const pool = new Pool({ connectionString: target, max: 4 })
  const org = await import('../governance/organizations')
  const { workspaceDb, workspacePool } = await import('../workspace-db')
  const { pool: appPool } = await import('../db')
  const { requireWorkspace } = await import('../workspace-access')
  const { configureOrganizationResourcePolicy, requestOrganizationResourceApproval, decideOrganizationResourceApproval } = await import('../governance/resource-policy')
  const { organizationResourceAllowed } = await import('../governance/resource-access')
  const { createOrganizationAuditExport, readOrganizationAuditExport, applyOrganizationAuditRetention } = await import('../governance/audit-export')
  const { commitIdentityChange, deliverIdentityAudits } = await import('./audit-outbox')
  const { provisionOrganizationPlan } = await import('./provisioning')
  const { provisionWorkspacePlan } = await import('../governance/provisioning')
  const { manageIdentity } = await import('./management')
  t.after(async () => { await Promise.all([pool.end(), workspacePool.end(), appPool.end()]) })
  const owner = { id: randomUUID(), name: 'Organization owner', email: `${randomUUID()}@org-fixture.example.invalid` }
  const admin = { id: randomUUID(), name: 'Organization admin', email: `${randomUUID()}@org-fixture.example.invalid` }
  const member = { id: randomUUID(), name: 'Organization member', email: `${randomUUID()}@org-fixture.example.invalid` }
  const outsider = { id: randomUUID(), name: 'Other organization', email: `${randomUUID()}@org-fixture.example.invalid` }
  for (const user of [owner, admin, member, outsider]) await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,now(),now())', [user.id, user.name, user.email])
  const organization = await org.createOrganization(owner, { name: 'Enterprise governance fixture' })
  const organizationId = organization.id
  await org.addOrganizationMember(organizationId, owner.id, { userId: admin.id, role: 'admin' })
  await org.addOrganizationMember(organizationId, owner.id, { userId: member.id })
  const wsA = randomUUID(), wsB = randomUUID(), unrelated = randomUUID()
  for (const id of [wsA, wsB, unrelated]) {
    await pool.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,\'Workspace ACL fixture\',\'team\')', [id, owner.id])
    for (const [user, role] of [[owner, 'admin'], [member, 'member']] as const) await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role) values ($1,$2,$3,$4,$5)', [id, user.id, user.name, user.email, role])
  }
  await t.test('Org roles cannot grant Workspace access or elevate other owners', async () => {
    await assert.rejects(org.renameOrganization(organizationId, member.id, { name: 'Unauthorized' }))
    await assert.rejects(org.addOrganizationMember(organizationId, admin.id, { userId: outsider.id, role: 'owner' }))
    await assert.rejects(org.updateOrganizationMember(organizationId, owner.id, { userId: owner.id, role: 'member' }))
    await assert.rejects(org.removeOrganizationMember(organizationId, owner.id, owner.id))
    await assert.rejects(org.attachOrganizationWorkspace(organizationId, wsA, admin.id))
    await org.attachOrganizationWorkspace(organizationId, wsA, owner.id)
    await org.attachOrganizationWorkspace(organizationId, wsB, owner.id)
    await assert.rejects(workspaceDb.transaction(tx => requireWorkspace(tx, wsA, admin.id)))
    await org.renameOrganization(organizationId, admin.id, { name: 'Renamed Enterprise fixture' })
    const summary = await org.organizationSummary(organizationId, owner.id)
    assert.equal(summary.organization.name, 'Renamed Enterprise fixture')
    assert.equal(summary.activeHumans, 2, 'the same active humans in two Workspaces are counted once for management')
    assert.deepEqual(summary.workspaceIds.sort(), [wsA, wsB].sort())
    await assert.rejects(org.archiveOrganization(organizationId, owner.id), error => (error as { detail?: string }).detail === 'workspace_attached')
  })
  const policy = { modelCredentialSharing: 'approval_required', mcpSharing: 'approval_required', allowedModelProviders: null, auditRetentionDays: null, legalHold: false } as const
  await t.test('operator Enterprise grants serialize expected-plan changes and preserve historical seat metadata without payments', async () => {
    const grant = { organizationId, expectedPlan: 'free', plan: 'enterprise', source: 'cloud', seatLimit: 2,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), reason: 'evaluation', operator: 'enterprise-fixture' }
    const preview = await provisionOrganizationPlan(pool, grant)
    assert.equal(preview.applied, false); assert.equal(preview.activeHumans, 2); assert.equal(preview.after.plan, 'enterprise')
    assert.equal((await pool.query('select plan from mikka_organization_entitlements where "organizationId"=$1', [organizationId])).rows[0].plan, 'free')
    const concurrent = await Promise.allSettled([provisionOrganizationPlan(pool, grant, { apply: true }), provisionOrganizationPlan(pool, grant, { apply: true })])
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = concurrent.find(result => result.status === 'rejected') as PromiseRejectedResult
    assert.equal(rejected.reason.detail, 'invalid_request')
    assert.equal((await provisionOrganizationPlan(pool, { ...grant, expectedPlan: 'enterprise' }, { apply: true })).changed, false)
    assert.equal((await pool.query('select count(*) from mikka_organization_audit_events where "organizationId"=$1 and action=\'entitlement.changed\'', [organizationId])).rows[0].count, '1')
    await assert.rejects(provisionOrganizationPlan(pool, { ...grant, source: 'license' }, { apply: true }), error => (error as { detail?: string }).detail === 'invalid_request')
    const reduced = await provisionOrganizationPlan(pool, { ...grant, expectedPlan: 'enterprise', seatLimit: 1, reason: 'correction' }, { apply: true })
    assert.equal(reduced.overLimit, false)
    assert.equal(reduced.after.activeHumanLimit, null)
    assert.equal(reduced.activeHumans, 2, 'legacy seat metadata cannot restrict or evict members')
    await provisionOrganizationPlan(pool, { ...grant, expectedPlan: 'enterprise', reason: 'correction' }, { apply: true })
  })
  await t.test('a bound Workspace cannot acquire a dormant local grant behind its Organization plan', async () => {
    const grant = { workspaceId: wsA, expectedPlan: 'free', plan: 'pro', source: 'cloud', seatLimit: 20,
      expiresAt: null, reason: 'evaluation', operator: 'enterprise-fixture' }
    for (const apply of [false, true]) {
      await assert.rejects(provisionWorkspacePlan(pool, grant, { apply }), error => (error as { detail?: string }).detail === 'workspace_attached')
    }
    assert.equal((await pool.query('select count(*) from mikka_workspace_entitlements where "workspaceId"=$1', [wsA])).rows[0].count, '0')
    assert.equal((await pool.query('select plan from mikka_organization_entitlements where "organizationId"=$1', [organizationId])).rows[0].plan, 'enterprise')
  })
  await t.test('the operator CLI previews, applies once and refuses bound Workspace grants without printing rejected input', async () => {
    const grant = { organizationId, expectedPlan: 'enterprise', plan: 'enterprise', source: 'cloud', seatLimit: 3,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), reason: 'correction', operator: 'cli-fixture' }
    const invoke = (script: 'organization-plan' | 'team-plan', input: unknown, args: string[] = []) => spawnSync(process.execPath,
      ['--conditions=react-server', '--import', 'tsx', `scripts/${script}.mjs`, ...args],
      { cwd: new URL('../..', import.meta.url), env: process.env, encoding: 'utf8', input: typeof input === 'string' ? input : JSON.stringify(input), timeout: 15_000, maxBuffer: 65_536 })
    const before = Number((await pool.query('select count(*) from mikka_organization_audit_events where "organizationId"=$1 and action=\'entitlement.changed\'', [organizationId])).rows[0].count)
    const preview = invoke('organization-plan', grant)
    assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).applied, false)
    assert.equal((await pool.query('select "seatLimit" from mikka_organization_entitlements where "organizationId"=$1', [organizationId])).rows[0].seatLimit, 2)
    const applied = invoke('organization-plan', grant, ['--apply'])
    assert.equal(applied.status, 0, applied.stderr); assert.equal(JSON.parse(applied.stdout).after.activeHumanLimit, null)
    const repeated = invoke('organization-plan', grant, ['--apply'])
    assert.equal(repeated.status, 0, repeated.stderr); assert.equal(JSON.parse(repeated.stdout).changed, false)
    assert.equal(Number((await pool.query('select count(*) from mikka_organization_audit_events where "organizationId"=$1 and action=\'entitlement.changed\'', [organizationId])).rows[0].count), before + 1)
    const malformed = invoke('organization-plan', '"fixture-private-input')
    assert.equal(malformed.status, 1); assert.equal(malformed.stdout, ''); assert.ok(!malformed.stderr.includes('fixture-private-input'))
    const bound = invoke('team-plan', { workspaceId: wsA, expectedPlan: 'free', plan: 'pro', source: 'cloud', seatLimit: 20, expiresAt: null, reason: 'evaluation', operator: 'cli-fixture' }, ['--apply'])
    assert.equal(bound.status, 1); assert.match(bound.stderr, /workspace_attached/); assert.equal(bound.stdout, '')
    assert.equal((await pool.query('select count(*) from mikka_workspace_entitlements where "workspaceId"=$1', [wsA])).rows[0].count, '0')
  })
  await t.test('identity configuration keeps its audit intent through Workspace-store failure and retries exactly once', async () => {
    const constraint = `enterprise_audit_fixture_${randomUUID().replaceAll('-', '')}`
    await pool.query(`alter table mikka_organization_audit_events add constraint "${constraint}" check ("organizationId"<>'${organizationId}'::uuid or action<>'sso.policy_changed') not valid`)
    try {
      await commitIdentityChange({ organizationId, actorId: owner.id, action: 'sso.policy_changed', metadata: { enabled: false } }, tx =>
        tx.query('insert into enterprise_org_policy ("organizationId","allowMachineCredentials") values ($1,true) on conflict ("organizationId") do update set "allowMachineCredentials"=true', [organizationId]))
      assert.equal((await pool.query('select "allowMachineCredentials" from enterprise_org_policy where "organizationId"=$1', [organizationId])).rows[0].allowMachineCredentials, true)
      assert.equal((await pool.query('select count(*) from enterprise_audit_outbox where "organizationId"=$1 and "deliveredAt" is null', [organizationId])).rows[0].count, '1')
    } finally { await pool.query(`alter table mikka_organization_audit_events drop constraint "${constraint}"`) }
    assert.equal((await deliverIdentityAudits(organizationId)).delivered, 1)
    assert.equal((await deliverIdentityAudits(organizationId)).delivered, 0)
    assert.equal((await pool.query('select count(*) from mikka_organization_audit_events where "organizationId"=$1 and action=\'sso.policy_changed\'', [organizationId])).rows[0].count, '1')
    await assert.rejects(commitIdentityChange({ organizationId, actorId: owner.id, action: 'sso.policy_changed', metadata: { password: 'not-allowed' } }, tx =>
      tx.query('update enterprise_org_policy set "allowMachineCredentials"=false where "organizationId"=$1', [organizationId])))
    assert.equal((await pool.query('select "allowMachineCredentials" from enterprise_org_policy where "organizationId"=$1', [organizationId])).rows[0].allowMachineCredentials, true, 'invalid audit data rolls back the configuration mutation')
  })
  await t.test('an expired Enterprise grant can close identity controls but cannot enable new enterprise authority', async () => {
    const sessionId = randomUUID()
    await pool.query('insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values($1,$2,$3,now()+interval \'1 hour\',now(),now())', [sessionId, randomUUID(), owner.id])
    const session = { user: { id: owner.id }, session: { id: sessionId } }
    await pool.query('update mikka_organization_entitlements set "expiresAt"=now()-interval \'1 second\' where "organizationId"=$1', [organizationId])
    await assert.rejects(manageIdentity(organizationId, session, { action: 'policy', enforceSso: false, allowMachineCredentials: true }, 'https://fixture.example.invalid'), error => (error as { detail?: string }).detail === 'feature_unavailable')
    assert.deepEqual(await manageIdentity(organizationId, session, { action: 'policy', enforceSso: false, allowMachineCredentials: false }, 'https://fixture.example.invalid'), { enforceSso: false, allowMachineCredentials: false })
    await pool.query('update mikka_organization_entitlements set "expiresAt"=now()+interval \'1 hour\' where "organizationId"=$1', [organizationId])
  })
  await t.test('an identity mutation retains Organization authorization until its Auth DB commit', async () => {
    const sessionId = randomUUID()
    await pool.query('insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values($1,$2,$3,now()+interval \'1 hour\',now(),now())', [sessionId, randomUUID(), admin.id])
    const session = { user: { id: admin.id }, session: { id: sessionId } }
    const blocker = await pool.connect(), revoker = await pool.connect()
    const blockerPid = (await blocker.query('select pg_backend_pid() as pid')).rows[0].pid
    const revokerPid = (await revoker.query('select pg_backend_pid() as pid')).rows[0].pid
    let mutation: Promise<unknown> | undefined, revocation: Promise<void> | undefined
    let mutationDone = false, roleChanged = false, mutationError: unknown, revocationError: unknown
    const until = async (ready: () => Promise<boolean>) => {
      const deadline = Date.now() + 3000
      while (!await ready()) {
        assert.ok(Date.now() < deadline, 'the database lock barrier must become observable')
        await delay(10)
      }
    }
    try {
      await blocker.query('begin')
      await blocker.query('select "organizationId" from enterprise_org_policy where "organizationId"=$1 for update', [organizationId])
      mutation = manageIdentity(organizationId, session, { action: 'policy', enforceSso: false, allowMachineCredentials: true }, 'https://fixture.example.invalid')
        .then(value => { mutationDone = true; return value }, error => { mutationDone = true; mutationError = error })
      await until(async () => mutationDone || (await pool.query('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked', [blockerPid])).rows[0].blocked)
      assert.equal(mutationDone, false, 'the mutation has passed authorization and is waiting on the real Auth DB row')
      // This is the same Organization-first row lock taken by role changes. Its
      // dedicated backend PID makes the competing transaction observable without timing assumptions.
      revocation = (async () => {
        await revoker.query('begin')
        await revoker.query('select id from mikka_organizations where id=$1 for update', [organizationId])
        await revoker.query('update mikka_organization_members set role=\'member\' where "organizationId"=$1 and "userId"=$2', [organizationId, admin.id])
        await revoker.query('commit'); roleChanged = true
      })().catch(error => { revocationError = error; roleChanged = true })
      await until(async () => roleChanged || (await pool.query('select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type=\'Lock\') as blocked', [revokerPid])).rows[0].blocked)
      assert.equal(roleChanged, false, 'the administrator cannot be revoked before its already-authorized identity write commits')
      await blocker.query('rollback')
      await mutation; await revocation
      assert.equal(mutationError, undefined); assert.equal(revocationError, undefined)
      assert.equal((await pool.query('select "allowMachineCredentials" from enterprise_org_policy where "organizationId"=$1', [organizationId])).rows[0].allowMachineCredentials, true)
      await assert.rejects(manageIdentity(organizationId, session, { action: 'policy', enforceSso: false, allowMachineCredentials: false }, 'https://fixture.example.invalid'), error => (error as { detail?: string }).detail === 'access_denied')
    } finally {
      await blocker.query('rollback'); blocker.release()
      await Promise.allSettled([mutation, revocation].filter(value => value !== undefined))
      await revoker.query('rollback'); revoker.release()
      await org.updateOrganizationMember(organizationId, owner.id, { userId: admin.id, role: 'admin' })
      await pool.query('update enterprise_org_policy set "allowMachineCredentials"=false where "organizationId"=$1', [organizationId])
    }
  })
  await t.test('resource owners request explicit approval; an Org admin cannot bypass the Workspace source grant', async () => {
    await configureOrganizationResourcePolicy(organizationId, owner.id, policy)
    const approval = await requestOrganizationResourceApproval(organizationId, member.id, { workspaceId: wsA, kind: 'subscription', resourceId: member.id })
    assert.equal(await organizationResourceAllowed(wsA, 'subscription', member.id, member.id), false)
    await assert.rejects(decideOrganizationResourceApproval(organizationId, member.id, { id: approval.id, status: 'approved' }))
    await decideOrganizationResourceApproval(organizationId, admin.id, { id: approval.id, status: 'approved' })
    assert.equal(await organizationResourceAllowed(wsA, 'subscription', member.id, member.id), true)
    await assert.rejects(workspaceDb.transaction(tx => requireWorkspace(tx, wsA, admin.id)))
    await decideOrganizationResourceApproval(organizationId, admin.id, { id: approval.id, status: 'denied' })
    assert.equal(await organizationResourceAllowed(wsA, 'subscription', member.id, member.id), false)
    await requestOrganizationResourceApproval(organizationId, member.id, { workspaceId: wsA, kind: 'subscription', resourceId: member.id })
    assert.equal(await organizationResourceAllowed(wsA, 'subscription', member.id, member.id), false, 'replay cannot erase a denial')
  })
  await t.test('removing Org membership suspends only its Workspaces and revokes scoped PATs without deleting identity', async () => {
    const scoped = randomUUID(), other = randomUUID()
    for (const [id, workspaceId] of [[scoped, wsA], [other, unrelated]]) await pool.query('insert into personal_access_tokens (id,"userId","workspaceId",name,"tokenHash",hint) values ($1,$2,$3,\'Fixture\',$4,\'test\')', [id, member.id, workspaceId, identityTokenHash(randomUUID())])
    await org.removeOrganizationMember(organizationId, admin.id, member.id)
    assert.equal((await pool.query('select count(*) from mikka_workspace_members where "userId"=$1 and "workspaceId"=any($2::uuid[]) and status=\'suspended\'', [member.id, [wsA, wsB]])).rows[0].count, '2')
    assert.equal((await pool.query('select status from mikka_workspace_members where "userId"=$1 and "workspaceId"=$2', [member.id, unrelated])).rows[0].status, 'active')
    assert.ok((await pool.query('select "revokedAt" from personal_access_tokens where id=$1', [scoped])).rows[0].revokedAt)
    assert.equal((await pool.query('select "revokedAt" from personal_access_tokens where id=$1', [other])).rows[0].revokedAt, null)
    assert.equal((await pool.query('select count(*) from "user" where id=$1', [member.id])).rows[0].count, '1')
  })
  await t.test('audit exports enforce current Org admin authority, tenant binding, caps and integrity', async () => {
    await assert.rejects(createOrganizationAuditExport(organizationId, member.id, {}))
    await assert.rejects(createOrganizationAuditExport(organizationId, owner.id, {}, new Date(), 1), error => (error as { code?: string }).code === 'auditExportLimitExceeded')
    const bundle = await createOrganizationAuditExport(organizationId, admin.id, {})
    assert.ok(verifyAuditExport(bundle.manifest, bundle.events))
    assert.ok(bundle.events.some(event => event.action === 'organization.member_removed'))
    const page = await readOrganizationAuditExport(organizationId, admin.id, bundle.manifest.id, 0, 2)
    assert.equal(page.events.length, 2); assert.equal(page.nextOffset, 2)
    const otherOrg = await org.createOrganization(owner, { name: 'Other audit tenant' })
    await assert.rejects(readOrganizationAuditExport(otherOrg.id, owner.id, bundle.manifest.id))
    await org.updateOrganizationMember(organizationId, owner.id, { userId: admin.id, role: 'member' })
    await assert.rejects(readOrganizationAuditExport(organizationId, admin.id, bundle.manifest.id))
    await org.updateOrganizationMember(organizationId, owner.id, { userId: admin.id, role: 'admin' })
    const first = bundle.events[0]
    await pool.query('update mikka_organization_audit_events set "targetId"=$2 where id=$1', [first.id, randomUUID()])
    await assert.rejects(readOrganizationAuditExport(organizationId, owner.id, bundle.manifest.id), error => (error as { code?: string }).code === 'auditExportChanged')
  })
  await t.test('retention respects legal hold and live export leases, then records bounded deletion', async () => {
    const oldId = randomUUID()
    await pool.query('insert into mikka_organization_audit_events (id,"organizationId","actorId",action,metadata,"createdAt") values ($1,$2,$3,\'organization.member_changed\',\'{}\',now()-interval \'2 days\')', [oldId, organizationId, owner.id])
    await configureOrganizationResourcePolicy(organizationId, owner.id, { ...policy, auditRetentionDays: 1, legalHold: true })
    assert.equal((await applyOrganizationAuditRetention(organizationId)).skipped, 'legal_hold')
    await configureOrganizationResourcePolicy(organizationId, owner.id, { ...policy, auditRetentionDays: 1 })
    assert.equal((await applyOrganizationAuditRetention(organizationId)).skipped, 'active_export')
    await pool.query('update mikka_organization_audit_exports set "expiresAt"=now()-interval \'1 second\' where "organizationId"=$1', [organizationId])
    assert.equal((await applyOrganizationAuditRetention(organizationId)).deleted, 1)
    assert.equal((await pool.query('select count(*) from mikka_organization_audit_events where id=$1', [oldId])).rows[0].count, '0')
    assert.equal((await pool.query('select count(*) from mikka_organization_audit_events where "organizationId"=$1 and action=\'organization.retention_applied\'', [organizationId])).rows[0].count, '1')
  })
  await t.test('archive is owner-only, retains audit and leaves detached Workspace history intact', async () => {
    await org.detachOrganizationWorkspace(organizationId, wsA, owner.id)
    await org.detachOrganizationWorkspace(organizationId, wsB, owner.id)
    await assert.rejects(org.archiveOrganization(organizationId, admin.id))
    assert.deepEqual(await org.archiveOrganization(organizationId, owner.id), { archived: true })
    assert.deepEqual(await org.archiveOrganization(organizationId, owner.id), { archived: true })
    assert.equal((await org.listOrganizations(owner.id)).some(row => row.id === organizationId), false)
    await assert.rejects(org.renameOrganization(organizationId, owner.id, { name: 'Cannot restore by rename' }))
    assert.equal((await pool.query('select count(*) from mikka_workspaces where id=any($1::uuid[])', [[wsA, wsB]])).rows[0].count, '2')
    assert.ok((await createOrganizationAuditExport(organizationId, owner.id, {})).events.some(event => event.action === 'organization.archived'))
  })

  const deletionUser = async () => {
    const user = { id: randomUUID(), name: 'Deletion owner fixture', email: `${randomUUID()}@delete-org.example.invalid` }
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$2,$3,true,now(),now())', [user.id, user.name, user.email])
    return user
  }
  await t.test('the last Organization owner cannot start account cleanup or leave durable guards behind', async () => {
    const subject = await deletionUser(), successor = await deletionUser()
    const created = await org.createOrganization(subject, { name: 'Last owner deletion fixture' })
    const sessionId = randomUUID(), token = randomUUID()
    await pool.query(`insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values($1,$2,$3,now()+interval '1 hour',now(),now())`, [sessionId, token, subject.id])
    const beforeAudit = (await pool.query('select * from mikka_organization_audit_events where "organizationId"=$1 order by id', [created.id])).rows
    const { deleteAccount } = await import('../account/delete')
    const { requestAccountDeletion, cancelAccountDeletion } = await import('../account/deletion-jobs')
    let external = 0
    const options = { mainPool: pool, workspacePool, externalCleanup: async () => { external++; return [] as string[] } }
    await assert.rejects(deleteAccount(subject.id, subject.email, options), error => (error as { detail?: string }).detail === 'last_owner')
    assert.equal(external, 0)
    assert.equal((await pool.query('select count(*) from "user" where id=$1', [subject.id])).rows[0].count, '1')
    assert.equal((await pool.query('select count(*) from session where id=$1 and token=$2', [sessionId, token])).rows[0].count, '1')
    assert.equal((await pool.query('select count(*) from account_deletion_guards where "subjectId"=$1', [subject.id])).rows[0].count, '0')
    assert.equal((await workspacePool.query('select count(*) from account_deletion_guards where "subjectId"=$1', [subject.id])).rows[0].count, '0')
    assert.deepEqual((await pool.query('select * from mikka_organization_audit_events where "organizationId"=$1 order by id', [created.id])).rows, beforeAudit)
    assert.equal((await pool.query('select stage from account_deletion_jobs where "subjectUserId"=$1', [subject.id])).rows[0].stage, 'cancelled')
    await org.renameOrganization(created.id, subject.id, { name: 'Still manageable after refusal' })
    await org.addOrganizationMember(created.id, subject.id, { userId: successor.id, role: 'owner' })
    const requested = await requestAccountDeletion(subject.id, subject.email, randomUUID(), options)
    assert.ok(requested.ok)
    await assert.rejects(org.createOrganization(subject, { name: 'Cannot acquire a new Org during deletion' }), error => /account_deletion_pending/.test(String((error as { cause?: unknown }).cause ?? error)))
    await assert.rejects(org.updateOrganizationMember(created.id, successor.id, { userId: successor.id, role: 'member' }), error => (error as { detail?: string }).detail === 'last_owner')
    await assert.rejects(org.removeOrganizationMember(created.id, successor.id, successor.id), error => (error as { detail?: string }).detail === 'last_owner')
    assert.equal(await cancelAccountDeletion(subject.id, requested.id, options), true)
    await org.updateOrganizationMember(created.id, successor.id, { userId: successor.id, role: 'member' })
    assert.equal(external, 0)
  })
  await t.test('canonical split-store ownership survives concurrent account requests and cleans only the departing membership', async t => {
    const { readFile } = await import('node:fs/promises')
    const { requestAccountDeletion, resumeAccountDeletion, cancelAccountDeletion } = await import('../account/deletion-jobs')
    const scope = `enterprise_account_${randomUUID().replaceAll('-', '')}`
    await pool.query(`create schema "${scope}"`)
    const canonical = new Pool({ connectionString: target, options: `-c search_path=${scope},public -c lock_timeout=5000 -c statement_timeout=15000`, application_name: scope, max: 4 })
    t.after(async () => { await canonical.end(); await pool.query(`drop schema "${scope}" cascade`) })
    const tables = ['mikka_workspaces', 'mikka_workspace_members', 'mikka_workspace_invitations', 'mikka_teams', 'mikka_team_members',
      'mikka_team_issues', 'mikka_team_projects', 'team_issue_create_receipts', 'team_issue_promotion_receipts', 'workspace_projects', 'workspace_project_events',
      'mikka_organizations', 'mikka_organization_members', 'mikka_organization_audit_events']
    for (const table of tables) await canonical.query(`create table "${scope}"."${table}" (like public."${table}" including defaults including constraints including indexes)`)
    await canonical.query(await readFile(new URL('../../drizzle/20261031050732_workspace_deletion_guards.sql', import.meta.url), 'utf8'))
    const a = await deletionUser(), b = await deletionUser(), id = randomUUID()
    for (const database of [pool, canonical]) await database.query('insert into mikka_organizations(id,name,"createdBy") values($1,$2,$3)', [id, 'Authoritative store fixture', a.id])
    const member = (database: Pool, user: typeof a) => database.query(`insert into mikka_organization_members("organizationId","userId",role,status,name,email) values($1,$2,'owner','active',$3,$4)`, [id, user.id, user.name, user.email])
    await member(pool, a); await member(pool, b); await member(canonical, a)
    let external = 0
    const options = { mainPool: pool, workspacePool: canonical, externalCleanup: async () => { external++; return [] as string[] }, deleteObject: async () => { throw new Error('Unexpected object cleanup') } }
    await assert.rejects(requestAccountDeletion(a.id, a.email, randomUUID(), options), error => (error as { detail?: string }).detail === 'last_owner')
    assert.equal(external, 0, 'APP same-name memberships cannot authorize deleting the only canonical owner')
    assert.equal((await canonical.query('select count(*) from account_deletion_guards where "subjectId"=$1', [a.id])).rows[0].count, '0')
    assert.equal((await pool.query('select count(*) from account_deletion_guards where "subjectId"=$1', [a.id])).rows[0].count, '0')
    await member(canonical, b)
    const blocker = await canonical.connect()
    const blockerPid = (await blocker.query('select pg_backend_pid() as pid')).rows[0].pid
    const requests: Promise<Awaited<ReturnType<typeof requestAccountDeletion>>>[] = []
    let settled = 0
    try {
      await blocker.query('begin')
      await blocker.query('select id from mikka_organizations where id=$1 for update', [id])
      for (const user of [a, b]) {
        const pending = requestAccountDeletion(user.id, user.email, randomUUID(), options)
        void pending.then(() => { settled++ }, () => { settled++ })
        requests.push(pending)
      }
      const deadline = Date.now() + 3000
      // PostgreSQL may queue the second row waiter behind the first waiter.
      // Follow that real lock chain instead of requiring two direct blockers.
      while (Number((await pool.query(`with recursive blocked(pid) as (
        select $2::integer
        union
        select activity.pid from pg_stat_activity activity
          join blocked parent on parent.pid=any(pg_blocking_pids(activity.pid))
          where activity.application_name=$1
        ) select count(*) from blocked where pid<>$2::integer`, [scope, blockerPid])).rows[0].count) < 2) {
        assert.equal(settled, 0, 'both requests reach the real canonical Organization row lock')
        assert.ok(Date.now() < deadline, 'the two database waits become observable')
        await delay(10)
      }
    } finally { await blocker.query('rollback'); blocker.release() }
    const outcomes = await Promise.allSettled(requests)
    const accepted = outcomes.flatMap((result, index) => result.status === 'fulfilled' && result.value.ok ? [{ id: result.value.id, user: [a, b][index] }] : [])
    assert.ok(accepted.length <= 1, 'two owners cannot both commit an irreversible deletion plan')
    for (const result of outcomes) if (result.status === 'rejected') assert.equal((result.reason as { detail?: string }).detail, 'last_owner')
    const available = (await canonical.query(`select m."userId" from mikka_organization_members m
      where m."organizationId"=$1 and m.role='owner' and m.status='active'
      and not exists(select 1 from account_deletion_guards g where g."subjectId"=m."userId")`, [id])).rows as { userId: string }[]
    assert.ok(available.length >= 1)
    const survivor = [a, b].find(user => user.id === available[0].userId)!
    // Exercise actual writes in both stores; a row count alone would miss a
    // stranded account-write barrier after the refused request.
    await canonical.query('select mikka_account_assert_writable($1)', [survivor.id])
    const writableOrg = randomUUID()
    await canonical.query('insert into mikka_organizations(id,name,"createdBy") values($1,$2,$3)', [writableOrg, 'Still writable', survivor.id])
    await canonical.query(`insert into mikka_organization_members("organizationId","userId",role,status,name,email) values($1,$2,'owner','active',$3,$4)`, [writableOrg, survivor.id, survivor.name, survivor.email])
    await pool.query(`insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values($1,$2,$3,now()+interval '1 hour',now(),now())`, [randomUUID(), randomUUID(), survivor.id])
    if (!accepted.length) {
      const departing = [a, b].find(user => user.id !== survivor.id)!
      const requested = await requestAccountDeletion(departing.id, departing.email, randomUUID(), options)
      assert.ok(requested.ok); accepted.push({ id: requested.id, user: departing })
    }
    const departed = accepted[0]
    assert.notEqual(departed.user.id, survivor.id)
    const failAudit = `account_audit_${randomUUID().replaceAll('-', '')}`
    await canonical.query(`alter table mikka_organization_audit_events add constraint "${failAudit}" check ("organizationId"<>'${id}'::uuid or action<>'organization.member_removed') not valid`)
    try {
      await assert.rejects(resumeAccountDeletion(departed.id, options), error => {
        const failure = error as { code?: string; cause?: { code?: string } }
        return (failure.cause?.code ?? failure.code) === '23514'
      })
      assert.equal((await pool.query('select stage from account_deletion_jobs where id=$1', [departed.id])).rows[0].stage, 'main_deleted')
      assert.equal((await canonical.query('select count(*) from mikka_organization_members where "organizationId"=$1 and "userId"=$2', [id, departed.user.id])).rows[0].count, '1', 'member deletion and its audit roll back together')
      assert.equal((await canonical.query('select count(*) from mikka_organization_audit_events where "organizationId"=$1', [id])).rows[0].count, '0')
    } finally { await canonical.query(`alter table mikka_organization_audit_events drop constraint "${failAudit}"`) }
    assert.equal((await resumeAccountDeletion(departed.id, options)).stage, 'completed')
    const removedAudit = (await canonical.query('select action,"targetId",metadata from mikka_organization_audit_events where "organizationId"=$1', [id])).rows
    assert.deepEqual(removedAudit, [{ action: 'organization.member_removed', targetId: departed.user.id, metadata: { reason: 'account_deletion' } }])
    assert.equal((await resumeAccountDeletion(departed.id, options)).stage, 'completed')
    assert.deepEqual((await canonical.query('select action,"targetId",metadata from mikka_organization_audit_events where "organizationId"=$1', [id])).rows, removedAudit)
    assert.equal(external, 1)
    assert.equal((await pool.query('select count(*) from "user" where id=$1', [departed.user.id])).rows[0].count, '0')
    assert.deepEqual((await canonical.query('select "userId" from mikka_organization_members where "organizationId"=$1', [id])).rows, [{ userId: survivor.id }])
    assert.equal((await canonical.query('select count(*) from mikka_organizations where id=$1', [id])).rows[0].count, '1')
    assert.equal((await pool.query('select count(*) from mikka_organization_members where "organizationId"=$1', [id])).rows[0].count, '2', 'the APP mirror is not swept as authoritative membership')
    await canonical.query('select mikka_account_assert_writable($1)', [survivor.id])
    // The last remaining canonical owner still cannot delete itself after the
    // first owner's APP and Workspace stages have both completed.
    await assert.rejects(requestAccountDeletion(survivor.id, survivor.email, randomUUID(), options), error => (error as { detail?: string }).detail === 'last_owner')
    assert.equal(external, 1)
    await pool.query('select mikka_account_assert_writable($1)', [survivor.id])
    const liveJobs = (await pool.query(`select id,"subjectUserId" from account_deletion_jobs where "subjectUserId"=any($1::text[]) and stage in ('preparing','requested')`, [[a.id, b.id]])).rows
    for (const job of liveJobs) assert.equal(await cancelAccountDeletion(job.subjectUserId, job.id, options), true)
    await pool.query('delete from mikka_organization_members where "organizationId"=$1', [id])
    await pool.query('delete from mikka_organizations where id=$1', [id])
  })
})
