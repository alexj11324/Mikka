import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { runGovernanceProduction, governanceProductionExitCode } from './self-hosted-production-governance.mjs'
import { GovernanceSelectionError } from './self-hosted-production-governance-target.mjs'
import { TeamWorkspaceError } from './team-workspace.mjs'
import { governanceJournalEnvelope, verifyGovernanceJournalChain } from './self-hosted-production-governance-recovery.mjs'
import { auditDigest, auditExportRecords } from '../../lib/audit/integrity.ts'
import { encode } from '../../lib/desktop-rpc/wire.ts'

const SOURCE = 'a'.repeat(40), HEAD = 'b'.repeat(40), WINDOW_HASH = 'c'.repeat(64)
const OWNER = 'owner-fixture', SESSION = 'session-fixture', PRIOR_SESSION = 'prior-session-fixture'
const PERSONAL = '10000000-0000-4000-8000-000000000001', ACME = '10000000-0000-4000-8000-000000000002'
const OTHER = '10000000-0000-4000-8000-000000000003', ORG = '20000000-0000-4000-8000-000000000001'
const BASE = '20000000-0000-4000-8000-000000000002', DUPLICATE = '20000000-0000-4000-8000-000000000003'
const NONCE = '30000000-0000-4000-8000-000000000001', EXPORT = '40000000-0000-4000-8000-000000000001'
const START = Date.parse('2026-11-10T04:00:00.123Z')
const fingerprint = (kind, value) => createHash('sha256').update(kind + '\0' + value).digest('hex')
const email = 'offline+mikka-smoke@example.test'
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers })
const originalName = '测试1856 organization ' + NONCE

function fixture(options = {}) {
  let clock = START, currentWorkspace = options.recovery ? ACME : PERSONAL, signedIn = false, barrier = Boolean(options.recoveryBarrier)
  let expired = false, creates = 0, archives = 0, identityReads = 0, leases = 0, signedOut = false
  let manifest, exportedEvents
  const password = randomUUID(), cookie = randomUUID(), priorToken = randomUUID() + randomUUID(), unrelatedToken = randomUUID() + randomUUID()
  const privateText = 'private-' + randomUUID()
  const requests = [], receipts = [], writes = [], sessions = new Map([
    [PRIOR_SESSION, { id: PRIOR_SESSION, userId: OWNER, token: priorToken }],
    ['unrelated-session', { id: 'unrelated-session', userId: OWNER, token: unrelatedToken }],
  ])
  const organizations = new Map([[BASE, { id: BASE, name: options.existingNonce ? originalName : 'Existing fixture organization',
    createdBy: OWNER, createdAt: new Date(START - 86400000).toISOString(), archivedAt: null }]])
  const makeOrg = name => ({ id: ORG, name, createdBy: options.wrongCreator ? 'another-owner' : OWNER,
    createdAt: new Date(options.oldCreatedAt ? START - 10000 : START).toISOString(), archivedAt: null })
  const events = []
  const auditEvent = action => ({ id: randomUUID(), organizationId: ORG, actorId: OWNER, action, result: 'success',
    correlationId: randomUUID(), targetId: action === 'organization.created' ? null : ORG, metadata: {},
    createdAt: new Date(clock).toISOString(), createdAtMicros: String(clock * 1000) })
  if (options.recovery && !options.recoveryNoOrg) {
    organizations.set(ORG, makeOrg(originalName))
    events.push(auditEvent('organization.created'))
  }
  const selection = { schema: 1, purpose: 'governance-1608-followup-selection', selected: true, status: 'selected',
    issue: 1608, pr: 1856, applicationSha: SOURCE, driverRevision: SOURCE, headSha: HEAD,
    driverRunId: 101, driverRunAttempt: options.recovery ? 2 : 1, window: {
      commentId: 202, markerSha256: WINDOW_HASH, nonce: NONCE,
      startsAt: new Date(START - 1000).toISOString(), expiresAt: new Date(START + 3600000).toISOString(),
      phase: options.recovery ? 'cleanup' : 'owner-audit',
    } }
  const old = { schema: 1, purpose: 'mikka1856-owned-organization', applicationSha: SOURCE, headSha: HEAD,
    driverRunId: 101, driverAttempt: 1, window: { commentId: 201, markerSha256: 'd'.repeat(64) },
    ownerHash: fingerprint('owner', options.recoveryWrongOwner ? 'another-owner' : OWNER),
    originalWorkspaceId: PERSONAL, selectedWorkspaceId: ACME, sessionIdHash: fingerprint('session', PRIOR_SESSION),
    priorSessionIdHashes: [], recoveryOf: null, nonce: NONCE, baselineOrgHashes: [fingerprint('organization', BASE)],
    intentAt: new Date(START).toISOString(), organizationId: options.recoveryBound ? ORG : null,
    organizationCreatedAt: options.recoveryBound ? new Date(START).toISOString() : null,
    ownershipVerified: Boolean(options.recoveryBound), emptyBindingsVerified: Boolean(options.recoveryBound),
    archiveIntent: Boolean(options.recoveryBound), archiveConfirmed: false,
    state: options.recoveryBound ? 'archive_intent' : 'create_intent', sequence: 1, previousSha256: null,
    observedAt: new Date(START).toISOString() }
  const oldEnvelope = governanceJournalEnvelope(old)
  selection.window.recovery = options.recovery ? { schema: 1, purpose: 'mikka1856-governance-journal-recovery',
    runId: 101, attempt: 1, jobId: 303, journalSha256: oldEnvelope.sha256 } : undefined
  if (options.recoveryUnexpectedWorkspace) currentWorkspace = OTHER
  const fetchImpl = async (rawUrl, init = {}) => {
    const url = new URL(rawUrl), path = url.pathname.slice('/mikka'.length), method = init.method ?? 'GET'
    const headers = new Headers(init.headers), body = init.body ? JSON.parse(init.body) : undefined
    requests.push({ path, method, query: url.search, workspace: headers.get('x-mikka-workspace-id') })
    assert.equal(url.origin, 'https://app.aspectlylabs.com')
    assert.equal(headers.get('origin'), url.origin)
    assert.equal(init.redirect, 'error')
    if (!['GET', 'HEAD'].includes(method)) writes.push({ path, method, lease: leases, journalState: receipts.at(-1)?.journal.state })
    if (path === '/api/auth/sign-in/email') {
      assert.equal(body.email, email); assert.equal(body.password, password); signedIn = true
      sessions.set(SESSION, { id: SESSION, userId: OWNER, token: cookie })
      return json({ user: { id: OWNER } }, 200, { 'set-cookie': 'session=' + cookie + '; Path=/; HttpOnly' })
    }
    if (path === '/api/auth/get-session') {
      assert.equal(url.searchParams.get('disableCookieCache'), 'true')
      if (!signedIn && options.emptyUnauthorized) return new Response(null, { status: 401 })
      return signedIn && headers.get('cookie') === 'session=' + cookie
        ? json({ user: { id: OWNER, email }, session: { id: SESSION } }) : json(null)
    }
    assert.equal(headers.get('cookie'), 'session=' + cookie)
    if (path === '/api/auth/sign-out') {
      if (!options.ignoreLogout) { signedIn = false; sessions.delete(SESSION) }
      signedOut = true
      return json({ success: true }, 200, { 'set-cookie': 'session=; Max-Age=0; Path=/' })
    }
    if (path === '/api/auth/list-sessions') return json([...sessions.values()])
    if (path === '/api/auth/revoke-session') {
      const found = [...sessions.values()].find(row => row.token === body.token)
      assert.ok(found && found.id === PRIOR_SESSION)
      sessions.delete(found.id); return json({ status: true })
    }
    if (path === '/api/workspace') return json({ currentUserId: OWNER,
      workspace: { id: currentWorkspace, kind: currentWorkspace === PERSONAL ? 'personal' : 'team' },
      choices: [{ id: PERSONAL, kind: 'personal' }, { id: ACME, kind: 'team' }, { id: OTHER, kind: 'team' }] })
    if (path === '/api/rpc') {
      assert.equal(body.action, 'workspace.switchWorkspace')
      assert.ok([PERSONAL, ACME].includes(body.args[0]))
      if (body.args[0] === PERSONAL && options.restoreForbidden)
        return json({ error: { code: 'governance_denied', detail: 'access_denied', privateText } }, 403)
      currentWorkspace = body.args[0]
      return json({ version: 1, ok: true, result: encode({ ok: true, data: {
        workspaceId: options.wrongRestore && currentWorkspace === PERSONAL ? OTHER : currentWorkspace } }) })
    }
    assert.ok(path === '/api/organizations' || path.startsWith('/api/organizations/' + ORG))
    assert.equal(headers.get('x-mikka-workspace-id'), ACME)
    if (path === '/api/organizations' && method === 'GET') return json({ organizations: [...organizations.values()]
      .filter(row => row.archivedAt === null).map(row => ({ id: row.id, name: row.name, role: 'owner' })) })
    if (path === '/api/organizations' && method === 'POST') {
      creates++; assert.equal(creates, 1)
      assert.equal(receipts.at(-1)?.journal.state, 'create_intent')
      assert.equal(body.name, originalName)
      if (options.lostBeforeCommit) throw new Error(privateText)
      const org = makeOrg(body.name)
      organizations.set(ORG, org); events.push(auditEvent('organization.created'))
      if (options.duplicate) organizations.set(DUPLICATE, { ...org, id: DUPLICATE })
      if (options.expireAfterCreate) expired = true
      if (options.budgetAfterCreate) clock += 180001
      if (options.lostCreate) throw new Error(privateText)
      if (options.create500) return json({ error: { code: 'governance_denied', detail: privateText }, secret: privateText }, 500)
      if (options.nonJsonCreate) return new Response(privateText, { status: 200 })
      return json({ id: options.returnBaselineId ? BASE : ORG, name: body.name, role: 'owner' })
    }
    const org = organizations.get(ORG)
    if (path === '/api/organizations/' + ORG && method === 'GET') {
      if (barrier || org.archivedAt) return json({ error: { code: 'governance_denied', detail: 'access_denied' } }, 403)
      return json({ organization: org, role: 'owner',
        members: [{ organizationId: ORG, userId: OWNER, role: 'owner', status: 'active' },
          ...(options.extraMember ? [{ organizationId: ORG, userId: 'someone-else', role: 'member', status: 'active' }] : [])],
        workspaceIds: options.attachedWorkspace ? [ACME] : [], activeHumans: options.attachedWorkspace ? 2 : 0, audit: events })
    }
    if (path === '/api/organizations/' + ORG && method === 'PATCH') {
      assert.equal(receipts.at(-1)?.journal.state, 'rename_intent')
      org.name = body.name; events.push(auditEvent('organization.renamed'))
      return json({ organization: org })
    }
    if (path.endsWith('/identity')) {
      identityReads++
      if (barrier) return json({ error: { code: 'governance_denied', detail: 'access_denied' } }, 403)
      if (options.consumeCleanupBudget && identityReads > 1) { clock += 120001; throw new Error(privateText) }
      if (options.cleanupIdentityStream && identityReads > 1) return new Response(new ReadableStream({
        pull(controller) { controller.error(new Error(privateText)) },
      }), { status: 503 })
      if (options.cleanupIdentity503 && identityReads > 1) return new Response(privateText, { status: 503 })
      return json({ providers: options.provider ? [{ providerId: 'unexpected' }] : [],
        connections: options.scim ? [{ id: randomUUID(), revokedAt: null }] : [],
        policy: { enforceSso: false, allowMachineCredentials: false } })
    }
    if (path.endsWith('/policy')) return json({ policy: { modelCredentialSharing: options.badPolicy ? 'deny' : 'allow',
      mcpSharing: 'allow', allowedModelProviders: null, auditRetentionDays: null, legalHold: false, revision: 0 }, approvals: [] })
    if (path.endsWith('/audit-log') && method === 'POST') {
      assert.equal(receipts.at(-1)?.journal.state, 'audit_intent')
      assert.deepEqual(Object.keys(body), ['from'])
      exportedEvents = structuredClone([...events].reverse())
      manifest = { format: 'mikka-organization-audit-export', version: 1, id: EXPORT, organizationId: ORG,
        createdAt: new Date(clock).toISOString(), until: new Date(clock).toISOString(),
        expiresAt: new Date(clock + 900000).toISOString(), from: body.from, count: exportedEvents.length,
        digest: auditDigest(auditExportRecords(exportedEvents)) }
      return json({ manifest: { ...manifest, ...(options.badAudit ? { digest: '0'.repeat(64) } : {}) }, events: exportedEvents })
    }
    if (path.endsWith('/audit-log') && method === 'GET') {
      assert.equal(url.searchParams.get('exportId'), EXPORT)
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'))
      const rows = structuredClone(exportedEvents.slice(offset, offset + limit))
      if (options.changedPage && offset === 1) rows[0].actorId = 'another-owner'
      return json({ manifest: { ...manifest, ...(options.changedManifest && offset === 1 ? { expiresAt: new Date(clock + 990000).toISOString() } : {}) },
        events: rows, nextOffset: offset + rows.length < manifest.count ? offset + rows.length : null })
    }
    if (path === '/api/organizations/' + ORG && method === 'DELETE') {
      archives++; assert.equal(receipts.at(-1)?.journal.state, 'archive_intent')
      assert.equal(receipts.at(-1)?.journal.emptyBindingsVerified, true)
      if (options.archive500 || options.archiveBarrierOnce && archives === 1) {
        barrier = true
        return json({ error: { code: 'governance_denied' }, privateText }, 500)
      }
      if (!options.archiveStillListed) org.archivedAt = new Date(clock).toISOString()
      if (options.lostArchive && archives === 1) throw new Error(privateText)
      return json({ archived: !options.archiveFalse })
    }
    throw new Error('unhandled fixture route')
  }
  const args = { env: { SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: password }, event: {}, selection,
    now: () => clock, nonce: () => NONCE, fetchImpl,
    selectTarget: async ({ expectedSelection }) => {
      leases++
      if (options.notSelected) return { selected: false, status: 'not_selected', reason: 'no_marker' }
      if (expired || options.rejectTarget || options.expireBeforeSignIn && leases === 3
        || options.expireBeforeCreate && receipts.some(row => row.journal.state === 'create_intent'))
        throw new GovernanceSelectionError('governance_window_invalid', 'time')
      if (expectedSelection) assert.equal(expectedSelection.applicationSha, SOURCE)
      return structuredClone(selection)
    },
    selectTeam: async (client, { ownerId }, remember) => {
      assert.equal(ownerId, OWNER)
      const current = await client.json('/api/workspace'); remember(current.workspace.id)
      if (options.teamAdminMissing) throw new TeamWorkspaceError('team_admin_missing')
      await client.rpc('workspace.switchWorkspace', [ACME])
      return { workspaceId: ACME }
    },
    writeReceipt: async record => {
      if (options.journalBeforeCreate || options.journalAfterCreate && record.journal.state !== 'create_intent') throw new Error(privateText)
      receipts.push(structuredClone(record))
    },
    readRecovery: async () => ({ reference: selection.window.recovery, journal: oldEnvelope.journal,
      proof: { source: 'completed_github_job_log', originalAttempt: 1, journalSha256: oldEnvelope.sha256 } }),
  }
  return { args, requests, receipts, writes, organizations, sessions, privateText, password, cookie, priorToken, unrelatedToken,
    state: () => ({ creates, archives, leases, signedOut, currentWorkspace, identityReads }) }
}
const execute = async options => {
  const f = fixture(options), report = await runGovernanceProduction(f.args)
  for (const secret of [f.privateText, f.password, f.cookie, f.priorToken, f.unrelatedToken, email])
    assert.ok(!JSON.stringify({ report, receipts: f.receipts }).includes(secret))
  return { f, report }
}

test('selection refusal accesses no account credential or API', async () => {
  let read = false, requested = false
  const report = await runGovernanceProduction({ env: { get SMOKE_OWNER_EMAIL() { read = true; return email } },
    selectTarget: async () => ({ selected: false, status: 'not_selected' }), fetchImpl: async () => { requested = true } })
  assert.equal(report.status, 'not_selected'); assert.equal(read, false); assert.equal(requested, false)
})
test('normal owner scope passes two real-shaped audit pages and exact cleanup without claiming full Enterprise', async () => {
  const { f, report } = await execute()
  assert.equal(report.status, 'passed'); assert.equal(report.scopeComplete, true); assert.equal(report.fullEnterpriseAcceptance, false)
  assert.equal(report.driverRunAttempt, 1)
  assert.equal(report.cleanup.closed, true); assert.equal(report.checks.audit.pages, 2)
  assert.equal(report.cleanup.originalCookieRejected, true); assert.equal(report.cleanup.workspaceRestored, true)
  const { leases, ...state } = f.state()
  assert.deepEqual(state, { creates: 1, archives: 1, signedOut: true, currentWorkspace: PERSONAL, identityReads: 2 })
  const businessWrites = f.writes.filter(row => row.path === '/api/auth/sign-in/email'
    || row.path.startsWith('/api/organizations') && ['POST', 'PATCH'].includes(row.method))
  assert.equal(new Set(businessWrites.map(row => row.lease)).size, businessWrites.length)
  assert.ok(leases >= businessWrites.length)
  assert.equal(f.organizations.get(BASE).archivedAt, null)
  assert.ok(!f.requests.some(row => row.path.startsWith('/api/organizations/' + BASE)))
  assert.ok(!f.requests.some(row => row.path.startsWith('/api/workspaces/') || row.path.includes('/scim/')))
  assert.equal(f.requests.filter(row => row.path.endsWith('/audit-log') && row.method === 'GET').length, 2)
  assert.equal(verifyGovernanceJournalChain(f.receipts).journal.state, 'closed')
  assert.equal(governanceProductionExitCode(report), 0)
})
for (const mode of ['lostCreate', 'create500', 'nonJsonCreate']) test(mode + ': no second POST; unique nonce/owner/resource proof closes only its Org', async () => {
  const { f, report } = await execute({ [mode]: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, true)
  assert.equal(f.state().creates, 1); assert.equal(f.state().archives, 1); assert.equal(f.organizations.get(BASE).archivedAt, null)
  if (mode === 'create500') assert.equal(report.failure.httpStatus, 500)
})
for (const mode of ['lostBeforeCommit', 'duplicate', 'wrongCreator', 'oldCreatedAt',
  'attachedWorkspace', 'extraMember', 'provider', 'scim']) test(mode + ': unproven ownership or empty bindings never authorize archive', async () => {
  const { f, report } = await execute({ [mode]: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, false)
  assert.equal(f.state().archives, 0); assert.equal(f.state().signedOut, true)
  assert.equal(f.organizations.get(BASE).archivedAt, null)
})
test('a historical exact-name collision stops before create', async () => {
  const { f, report } = await execute({ existingNonce: true })
  assert.equal(report.status, 'failed'); assert.equal(f.state().creates, 0); assert.equal(f.state().archives, 0)
})
test('an invalid returned baseline ID is never used; full nonce recovery can still close the actual new Org', async () => {
  const { f, report } = await execute({ returnBaselineId: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, true)
  assert.equal(f.state().archives, 1); assert.equal(f.organizations.get(BASE).archivedAt, null)
  assert.ok(!f.requests.some(row => row.path.startsWith('/api/organizations/' + BASE)))
})
for (const mode of ['badPolicy', 'badAudit', 'changedPage', 'changedManifest']) test(mode + ': fails business proof but still closes the proven own resource', async () => {
  const { f, report } = await execute({ [mode]: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, true); assert.equal(f.state().archives, 1)
})
test('window expiry after create stops rename/audit but preserves exact cleanup', async () => {
  const { f, report } = await execute({ expireAfterCreate: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, true); assert.equal(f.state().archives, 1)
  assert.ok(!f.requests.some(row => row.method === 'PATCH' || row.path.endsWith('/audit-log')))
})
test('window refusal before create dispatch proves no POST was sent and does not invent an uncertain Org', async () => {
  const { f, report } = await execute({ expireBeforeCreate: true })
  assert.equal(report.status, 'failed'); assert.equal(f.state().creates, 0); assert.equal(f.state().archives, 0)
  assert.equal(report.cleanup.closed, true); assert.equal(report.cleanup.unresolvedOrganization, undefined)
})
test('window refusal before sign-in dispatch has no session to clean and retains the target refusal', async () => {
  const { f, report } = await execute({ expireBeforeSignIn: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, true)
  assert.equal(report.failure.code, 'governance_window_invalid')
  assert.equal(f.requests.length, 0); assert.equal(f.state().signedOut, false)
  assert.deepEqual(report.cleanup.failures, [])
})
test('Org cleanup budget exhaustion cannot consume the separate restore and current-session logout reserve', async () => {
  const { f, report } = await execute({ consumeCleanupBudget: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, false)
  assert.equal(report.cleanup.organizationArchived, undefined)
  assert.equal(report.cleanup.workspaceRestored, true); assert.equal(f.state().signedOut, true)
  assert.equal(report.cleanup.originalCookieRejected, true)
  assert.ok(f.requests.some(row => row.path === '/api/auth/sign-out'))
})
test('response stream failure retains the observed HTTP status without copying its native error', async () => {
  const { report } = await execute({ cleanupIdentityStream: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, false)
  const failure = report.cleanup.failures.find(row => row.step === 'organization_archive')
  assert.equal(failure.httpStatus, 503); assert.equal(failure.body.format, 'unavailable')
})
test('normal team prerequisite failures keep their existing closed classification and HTTP context', async () => {
  const { f, report } = await execute({ teamAdminMissing: true })
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'team_workspace_failed')
  assert.equal(report.failure.detail, 'team_admin_missing'); assert.equal(report.failure.httpStatus, 200)
  assert.equal(f.state().creates, 0); assert.equal(report.cleanup.closed, true)
})
test('normal restore refusal remains a cleanup failure with exact HTTP status, while logout still closes its session', async () => {
  const { report } = await execute({ restoreForbidden: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, false)
  const failure = report.cleanup.failures.find(row => row.step === 'workspace_restore')
  assert.equal(failure.httpStatus, 403); assert.equal(failure.body.detail, 'access_denied')
  assert.equal(report.cleanup.originalCookieRejected, true)
})
test('an empty 401 response proves the original cookie is rejected without inventing a JSON requirement', async () => {
  const { report } = await execute({ emptyUnauthorized: true })
  assert.equal(report.status, 'passed'); assert.equal(report.cleanup.originalCookieRejected, true)
})
test('business deadline reserves independent time for own archive, restore and logout', async () => {
  const { report } = await execute({ budgetAfterCreate: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, true)
})
for (const mode of ['archiveBarrierOnce', 'lostArchive']) test(mode + ': one exact idempotent completion closes an ambiguous archive', async () => {
  const { f, report } = await execute({ [mode]: true })
  assert.equal(report.status, 'passed'); assert.equal(report.cleanup.closed, true)
  assert.equal(f.state().archives, 2); assert.equal(report.cleanup.archiveCompletionRetry, true)
})
for (const mode of ['archive500', 'archiveFalse', 'archiveStillListed', 'cleanupIdentity503', 'ignoreLogout', 'wrongRestore']) test(mode + ': incomplete cleanup is a failing receipt', async () => {
  const { report } = await execute({ [mode]: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, false); assert.equal(governanceProductionExitCode(report), 1)
  if (mode === 'cleanupIdentity503') {
    const failure = report.cleanup.failures.find(row => row.step === 'organization_archive')
    assert.equal(failure.httpStatus, 503); assert.equal(failure.body.format, 'non_json')
  }
})
test('journal failure before the create intent prevents any organization write', async () => {
  const { f, report } = await execute({ journalBeforeCreate: true })
  assert.equal(report.status, 'failed'); assert.equal(f.state().creates, 0); assert.equal(f.state().archives, 0)
  assert.equal(report.cleanup.originalCookieRejected, true)
})
test('journal failure after create preserves unresolved intent rather than unjournaled archive', async () => {
  const { f, report } = await execute({ journalAfterCreate: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, false); assert.equal(f.state().archives, 0)
  assert.equal(f.receipts[0].journal.state, 'create_intent')
})
test('cleanup-only recovers a response-lost create and revokes only the hash-bound old session', async () => {
  const { f, report } = await execute({ recovery: true })
  assert.equal(report.status, 'cleanup_passed'); assert.equal(report.scopeComplete, false); assert.equal(report.cleanup.closed, true)
  assert.equal(f.state().creates, 0); assert.equal(f.state().archives, 1)
  assert.equal(f.sessions.has(PRIOR_SESSION), false); assert.equal(f.sessions.has('unrelated-session'), true)
  assert.ok(!f.requests.some(row => row.method === 'PATCH' || row.path.endsWith('/audit-log')))
})
test('a failed recovery write-ahead record cannot claim the prior Org or sessions were cleaned', async () => {
  const { f, report } = await execute({ recovery: true, journalBeforeCreate: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, false)
  assert.equal(report.cleanup.unresolvedOrganization, true)
  assert.equal(f.state().archives, 0); assert.equal(f.sessions.has(PRIOR_SESSION), true)
  assert.equal(report.cleanup.originalCookieRejected, true)
})
test('refused recovery proof never claims that the registered outstanding cleanup is closed', async () => {
  const f = fixture({ recovery: true })
  f.args.readRecovery = async () => { throw new Error(f.privateText) }
  const report = await runGovernanceProduction(f.args)
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, false)
  assert.equal(report.cleanup.unresolvedOrganization, true); assert.equal(f.requests.length, 0)
  assert.ok(!JSON.stringify(report).includes(f.privateText))
})
test('initial source or window refusal retains a preselected cleanup obligation without reading credentials', async () => {
  const f = fixture({ recovery: true, rejectTarget: true })
  let credentialRead = false
  f.args.env = { get SMOKE_OWNER_EMAIL() { credentialRead = true; throw new Error(f.privateText) } }
  const report = await runGovernanceProduction(f.args)
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, false)
  assert.equal(report.cleanup.unresolvedOrganization, true)
  assert.equal(report.failure.code, 'governance_window_invalid')
  assert.equal(credentialRead, false); assert.equal(f.requests.length, 0)
})
test('cleanup-only zero match retains unresolved create but still revokes its known prior session', async () => {
  const { f, report } = await execute({ recovery: true, recoveryNoOrg: true })
  assert.equal(report.status, 'failed'); assert.equal(report.cleanup.closed, false); assert.equal(f.state().archives, 0)
  assert.equal(f.sessions.has(PRIOR_SESSION), false)
})
test('cleanup-only may finish the already committed APP archive barrier despite normal summary refusal', async () => {
  const { f, report } = await execute({ recovery: true, recoveryBound: true, recoveryBarrier: true })
  assert.equal(report.status, 'cleanup_passed'); assert.equal(report.cleanup.closed, true); assert.equal(f.state().archives, 1)
})
test('an archive intent is not permission to ignore a current extra member before any barrier committed', async () => {
  const { f, report } = await execute({ recovery: true, recoveryBound: true, extraMember: true })
  assert.equal(report.status, 'failed'); assert.equal(f.state().archives, 0); assert.equal(report.cleanup.closed, false)
})
for (const mode of ['recoveryWrongOwner', 'recoveryUnexpectedWorkspace']) test(mode + ': no prior-session or Org mutation', async () => {
  const { f, report } = await execute({ recovery: true, [mode]: true })
  assert.equal(report.status, 'failed'); assert.equal(f.state().archives, 0); assert.equal(f.sessions.has(PRIOR_SESSION), true)
})