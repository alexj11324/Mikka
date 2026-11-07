import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
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
    assert.equal(summary.activeHumans, 2, 'the same active humans in two Workspaces consume two Org seats')
    assert.deepEqual(summary.workspaceIds.sort(), [wsA, wsB].sort())
    await assert.rejects(org.archiveOrganization(organizationId, owner.id), error => (error as { detail?: string }).detail === 'workspace_attached')
  })
  const policy = { modelCredentialSharing: 'approval_required', mcpSharing: 'approval_required', allowedModelProviders: null, auditRetentionDays: null, legalHold: false } as const
  await t.test('operator Enterprise grants serialize expected-plan changes and audit a deduplicated seat limit without payments', async () => {
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
    assert.equal(reduced.overLimit, true)
    assert.equal(reduced.activeHumans, 2, 'lowering a contract limit never evicts existing members')
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
    assert.equal(applied.status, 0, applied.stderr); assert.equal(JSON.parse(applied.stdout).after.activeHumanLimit, 3)
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
})
