#!/usr/bin/env node
// Normal owner APIs for one disposable Organization. This does not provision
// Enterprise, a workspace, identity provider, member, or SCIM credential.
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createSessionClient, smokeAcceptanceAccount, selectAcceptanceTeam, restoreAcceptanceWorkspace } from './cloud-startup.mjs'
import { TeamWorkspaceError, publicTeamWorkspaceFailure } from './team-workspace.mjs'
import { CORE_ORIGIN, CoreProductionError } from './self-hosted-production-target.mjs'
import { selectGovernanceProduction, governanceSelectionFailure, GovernanceSelectionError } from './self-hosted-production-governance-target.mjs'
import { governanceJournalEnvelope, governanceRecoveryFailure, readGovernanceRecovery, GOVERNANCE_JOURNAL_PREFIX } from './self-hosted-production-governance-recovery.mjs'
import { auditDigest, verifyAuditExport } from '../../lib/audit/integrity.ts'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const iso = value => typeof value === 'string' && value.length <= 35 && Number.isFinite(Date.parse(value))
const keys = value => object(value) ? Object.keys(value).sort().join(',') : ''
const hash = (kind, value) => createHash('sha256').update(kind + '\0' + value).digest('hex')
const post = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
const CODES = new Set(['target_refused', 'identity_failed', 'response_invalid', 'unexpected_status', 'request_failed',
  'budget_exhausted', 'journal_failed', 'organization_binding_failed', 'organization_unresolved', 'audit_integrity_failed',
  'cleanup_failed', 'recovery_scope_invalid', 'build_changed'])
const ERROR_CODES = new Set(['governance_denied', 'auditExportUnavailable', 'auditExportLimitExceeded', 'auditExportChanged'])
const DETAILS = new Set(['access_denied', 'seat_limit', 'feature_unavailable', 'last_owner', 'workspace_attached',
  'personal_workspace', 'invalid_request', 'template_limit', 'not_found', 'plan_changed'])

class ProbeError extends Error {
  constructor(code, httpStatus = null, body = null) {
    super(CODES.has(code) ? code : 'request_failed')
    this.name = 'GovernanceProbeError'; this.httpStatus = httpStatus; this.body = body
  }
}
const check = (value, code = 'response_invalid') => { if (!value) throw new ProbeError(code) }
const closedBody = (body, format = 'json') => ({ format,
  ...(ERROR_CODES.has(body?.error?.code) ? { errorCode: body.error.code } : {}),
  ...(DETAILS.has(body?.error?.detail) ? { detail: body.error.detail } : {}) })
function publicFailure(error, response) {
  let cursor = error, teamFailure
  for (let depth = 0; cursor && depth < 5; depth++, cursor = cursor.cause) {
    if (cursor instanceof ProbeError) return { code: cursor.message,
      httpStatus: cursor.httpStatus ?? response?.httpStatus ?? null, body: cursor.body ?? response?.body ?? null }
    const recovery = governanceRecoveryFailure(cursor)
    if (recovery) return recovery
    if (cursor instanceof GovernanceSelectionError || cursor instanceof CoreProductionError) return governanceSelectionFailure(cursor)
    if (cursor instanceof TeamWorkspaceError) teamFailure ??= cursor
  }
  if (teamFailure) return { ...publicTeamWorkspaceFailure(teamFailure),
    httpStatus: response?.httpStatus ?? null, body: response?.body ?? null }
  return { code: 'request_failed', httpStatus: response?.httpStatus ?? null, body: response?.body ?? null }
}
async function responseBody(response) {
  const reader = response.body?.getReader(), parts = []; let length = 0
  if (!reader) throw new ProbeError('response_invalid', response.status, closedBody(null, 'empty'))
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break
      length += next.value.byteLength
      if (length > 2_000_000) { await reader.cancel(); throw new ProbeError('response_invalid', response.status, closedBody(null, 'too_large')) }
      parts.push(next.value)
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')) }
    catch { throw new ProbeError('response_invalid', response.status, closedBody(null, length ? 'non_json' : 'empty')) }
  } finally { reader.releaseLock() }
}

/** Dependency injection is only for offline tests. The CLI fixes the target,
 * normal session client, account policy, and recovery provenance. */
export async function runGovernanceProduction({ env = process.env, event, selection, fetchImpl = fetch,
  selectTarget = selectGovernanceProduction, selectTeam = selectAcceptanceTeam, restoreWorkspace = restoreAcceptanceWorkspace,
  readRecovery = readGovernanceRecovery, now = Date.now, nonce = randomUUID,
  writeReceipt = async () => { throw new ProbeError('journal_failed') } } = {}) {
  const report = { schema: 1, kind: 'mikka1856-organization-owner-api', status: 'failed',
    scope: 'disposable-organization-owner-and-audit', scopeComplete: false, fullEnterpriseAcceptance: false,
    startedAt: new Date(now()).toISOString(), checks: {}, responses: [], cleanup: { closed: false, failures: [] },
    coverage: { organization: 'not_exercised', audit: 'not_exercised', teamPro: 'not_exercised',
      oidcRoundTrip: 'not_exercised', samlRoundTrip: 'not_exercised', scimLifecycle: 'not_exercised' },
    limitations: ['The create API uses the schema default Free entitlement; no Org owner GET exposes a plan grant.',
      'This scope does not create or prove paid plans, OIDC/SAML login, SCIM provisioning, or multiple-workspace administration.',
      'Owner archive retains Organization audit records. Export manifests have a 15-minute lease and normal server retention.'] }
  let selected, client, account, ownerId, identitySessionId, originalWorkspaceId, selectedWorkspaceId
  let originalCookie = '', signInAttempted = false, createAttempted = false, intentJournaled = false
  let closing = false, phase = 'target', lastResponse = null, recovery, journal, journalHash = null, sequence = 0
  const deadline = now() + 180_000
  let cleanupDeadline, bindingJournaled = false
  const oldSessions = [], allowedSessionTokens = new Set()
  const allowedNames = () => journal ? ['测试1856 organization ' + journal.nonce, '测试1856 organization ' + journal.nonce + ' verified'] : []
  const boundedFetch = (url, init = {}) => {
    const remaining = Math.min(15_000, (closing ? cleanupDeadline : deadline) - now())
    check(Number.isFinite(remaining) && remaining > 0, 'budget_exhausted')
    const signal = AbortSignal.timeout(Math.max(1, Math.floor(remaining)))
    const target = new URL(url)
    if (target.origin === CORE_ORIGIN && target.pathname === '/mikka/api/auth/sign-in/email' && init.method === 'POST')
      signInAttempted = true
    if (target.origin === CORE_ORIGIN && target.pathname === '/mikka/api/organizations' && init.method === 'POST')
      createAttempted = true
    return fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal })
  }
  const lease = async () => {
    lastResponse = null
    const fresh = await selectTarget({ env, event, fetchImpl: boundedFetch, now, expectedSelection: selected ?? selection })
    check(fresh?.selected === true && SHA.test(fresh.applicationSha ?? '') && SHA.test(fresh.headSha ?? '')
      && (!selected || fresh.applicationSha === selected.applicationSha && fresh.headSha === selected.headSha), 'target_refused')
    check(Date.parse(fresh.window.expiresAt) - now() >= 60_000, 'target_refused')
    selected = fresh
  }
  const checkpoint = async state => {
    const record = governanceJournalEnvelope({ ...journal, state, sequence: sequence + 1,
      previousSha256: journalHash, observedAt: new Date(now()).toISOString() })
    try { await writeReceipt(record) } catch { throw new ProbeError('journal_failed') }
    journal = record.journal; sequence++; journalHash = record.sha256
    intentJournaled = true
    if (journal.ownershipVerified && journal.emptyBindingsVerified) bindingJournaled = true
    report.journal = { state, sha256: journalHash, sequence, organizationId: journal.organizationId }
  }
  const cleanupWriteAllowed = (path, init) => {
    if (path === '/mikka/api/organizations/' + journal?.organizationId && init.method === 'DELETE')
      return intentJournaled && bindingJournaled && journal.archiveIntent === true && init.body === undefined
    if (init.method !== 'POST' || typeof init.body !== 'string' || init.body.length > 4096) return false
    let body; try { body = JSON.parse(init.body) } catch { return false }
    if (path === '/mikka/api/auth/sign-out') return keys(body) === ''
    if (path === '/mikka/api/auth/revoke-session') return Boolean(recovery) && intentJournaled
      && keys(body) === 'token' && allowedSessionTokens.has(body.token)
    return path === '/mikka/api/rpc' && ownerId && UUID.test(originalWorkspaceId ?? '')
      && keys(body) === 'action,args,version' && body.version === 1 && body.action === 'workspace.switchWorkspace'
      && Array.isArray(body.args) && body.args.length === 1 && body.args[0] === originalWorkspaceId
  }
  const request = async (step, path, init = {}, expected = [200], anonymous = false) => {
    phase = step; lastResponse = null; let response
    try {
      response = anonymous
        ? await boundedFetch(CORE_ORIGIN + '/mikka' + path, { ...init, redirect: 'error',
          headers: { origin: CORE_ORIGIN, 'cache-control': 'no-store', ...init.headers } })
        : await client.request(path, init)
    } catch (error) {
      for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++)
        if (current instanceof GovernanceSelectionError || current instanceof CoreProductionError
          || current instanceof ProbeError || current instanceof TeamWorkspaceError) throw current
      report.responses.push({ step, httpStatus: null, body: closedBody(null, 'transport') })
      throw new ProbeError('request_failed', null, closedBody(null, 'transport'))
    }
    if (response.status === 401 && expected.includes(401)) {
      await response.body?.cancel().catch(() => {})
      lastResponse = { step, httpStatus: response.status, body: closedBody(null, 'status_only') }
      report.responses.push(lastResponse)
      return { status: response.status, body: null }
    }
    let body
    try { body = await responseBody(response) }
    catch (error) {
      lastResponse = { step, httpStatus: response.status, body: error instanceof ProbeError ? error.body : closedBody(null, 'unavailable') }
      report.responses.push(lastResponse)
      if (error instanceof ProbeError) throw error
      throw new ProbeError('request_failed', response.status, lastResponse.body)
    }
    lastResponse = { step, httpStatus: response.status, body: closedBody(body) }
    report.responses.push(lastResponse)
    if (!expected.includes(response.status)) throw new ProbeError('unexpected_status', response.status, closedBody(body))
    return { status: response.status, body }
  }
  const listOrgs = async step => {
    const { body } = await request(step, '/api/organizations')
    check(Array.isArray(body?.organizations) && body.organizations.length <= 256
      && body.organizations.every(row => UUID.test(row?.id ?? '') && typeof row.name === 'string'
        && ['owner', 'admin', 'member'].includes(row.role))
      && new Set(body.organizations.map(row => row.id)).size === body.organizations.length)
    return body.organizations
  }
  const proveOwned = async () => {
    const rows = await listOrgs('organization_binding_list')
    const matches = rows.filter(row => allowedNames().includes(row.name) && row.role === 'owner'
      && !journal.baselineOrgHashes.includes(hash('organization', row.id)))
    check(matches.length === 1 && (!journal.organizationId || matches[0].id === journal.organizationId), 'organization_unresolved')
    if (!journal.organizationId) { journal.organizationId = matches[0].id; await checkpoint('candidate_recorded') }
    const path = '/api/organizations/' + journal.organizationId
    const { body: summary } = await request('organization_binding_summary', path)
    const org = summary?.organization
    check(org?.id === journal.organizationId && allowedNames().includes(org.name) && org.createdBy === ownerId
      && org.archivedAt === null && iso(org.createdAt)
      && Date.parse(org.createdAt) >= Math.floor(Date.parse(journal.intentAt) / 1000) * 1000
      && Date.parse(org.createdAt) <= now() + 1000
      && (!journal.organizationCreatedAt || journal.organizationCreatedAt === org.createdAt)
      && summary.role === 'owner' && Array.isArray(summary.members) && summary.members.length === 1
      && summary.members[0].organizationId === journal.organizationId && summary.members[0].userId === ownerId
      && summary.members[0].role === 'owner' && summary.members[0].status === 'active'
      && Array.isArray(summary.workspaceIds) && summary.workspaceIds.length === 0 && summary.activeHumans === 0,
    'organization_binding_failed')
    journal.organizationCreatedAt = org.createdAt; journal.ownershipVerified = true
    await checkpoint('ownership_bound')
    // This GET can deliver the new Org's own outbox. It is never called on a
    // baseline Org, nor used to inventory existing customers' identity settings.
    const { body: identity } = await request('organization_binding_identity', path + '/identity')
    check(Array.isArray(identity?.providers) && identity.providers.length === 0
      && Array.isArray(identity.connections) && identity.connections.length === 0
      && identity.policy?.enforceSso === false && identity.policy.allowMachineCredentials === false, 'organization_binding_failed')
    journal.emptyBindingsVerified = true; await checkpoint('organization_bound')
    return summary
  }
  const archiveOwn = async () => {
    if (journal.archiveIntent && journal.ownershipVerified && journal.emptyBindingsVerified) {
      const rows = await listOrgs('archive_resume_list')
      const current = rows.filter(row => row.id === journal.organizationId)
      check(current.length <= 1 && current.every(row => row.role === 'owner' && allowedNames().includes(row.name)),
        'organization_binding_failed')
      if (current.length) {
        const probe = await request('archive_resume_summary', '/api/organizations/' + journal.organizationId, {}, [200, 403])
        if (probe.status === 200) await proveOwned()
        else check(probe.body?.error?.code === 'governance_denied' && probe.body.error.detail === 'access_denied', 'organization_binding_failed')
      }
    } else await proveOwned()
    check(UUID.test(journal.organizationId ?? '') && journal.ownershipVerified && journal.emptyBindingsVerified, 'organization_binding_failed')
    journal.archiveIntent = true; await checkpoint('archive_intent')
    let confirmed = false
    for (let attempt = 0; attempt < 2; attempt++) {
      let result, error
      try { result = await request('organization_archive_' + (attempt + 1), '/api/organizations/' + journal.organizationId,
        { method: 'DELETE' }, [200, 400, 403, 409, 500, 502, 503, 504]) }
      catch (caught) { error = caught }
      if (result?.status === 200) { check(result.body?.archived === true, 'cleanup_failed'); confirmed = true; break }
      const recoverable = result ? [500, 502, 503, 504].includes(result.status)
        : error instanceof ProbeError && error.message === 'request_failed'
      if (!recoverable || attempt === 1) {
        if (error) throw error
        throw new ProbeError('cleanup_failed', result?.status ?? null, closedBody(result?.body))
      }
      // One bounded, idempotent completion of this exact archive barrier. A
      // normal detail GET may now be denied by the committed APP barrier.
      const rows = await listOrgs('archive_outcome_reconciliation')
      const current = rows.filter(row => row.id === journal.organizationId)
      check(current.length <= 1 && current.every(row => row.role === 'owner' && allowedNames().includes(row.name)), 'organization_binding_failed')
      report.cleanup.archiveCompletionRetry = true
    }
    check(confirmed, 'cleanup_failed')
    const remaining = await listOrgs('organizations_after_archive')
    check(!remaining.some(row => row.id === journal.organizationId), 'cleanup_failed')
    check(journal.baselineOrgHashes.every(value => remaining.some(row => hash('organization', row.id) === value)), 'cleanup_failed')
    journal.archiveConfirmed = true; await checkpoint('archived')
    report.cleanup.organizationArchived = true; report.cleanup.activeOwnerListAbsent = true
  }
  const clean = async (step, work) => {
    phase = step; lastResponse = null
    try { await work() } catch (error) { report.cleanup.failures.push({ step, ...publicFailure(error, lastResponse) }) }
  }
  try {
    selected = await selectTarget({ env, event, fetchImpl: boundedFetch, now, expectedSelection: selection })
    if (!selected?.selected) { report.status = 'not_selected'; report.selection = selected; return report }
    check(SHA.test(selected.applicationSha ?? '') && SHA.test(selected.headSha ?? '')
      && ['owner-audit', 'cleanup'].includes(selected.window?.phase), 'target_refused')
    report.applicationSha = selected.applicationSha; report.driverRunId = selected.driverRunId
    report.driverRunAttempt = selected.driverRunAttempt
    report.selection = { purpose: selected.purpose, pr: selected.pr, headSha: selected.headSha,
      phase: selected.window.phase, commentId: selected.window.commentId, markerSha256: selected.window.markerSha256,
      expiresAt: selected.window.expiresAt }
    await lease()
    if (selected.window.phase === 'cleanup') {
      phase = 'recovery_proof'
      recovery = await readRecovery({ reference: selected.window.recovery, selected, env, fetchImpl: boundedFetch, now })
      report.recovery = { ...recovery.proof, reference: recovery.reference }
    }
    account = smokeAcceptanceAccount(env)
    client = createSessionClient(CORE_ORIGIN, async (url, init) => {
      const target = new URL(url), headers = new Headers(init.headers)
      check(target.origin === CORE_ORIGIN && target.pathname.startsWith('/mikka/api/'), 'target_refused')
      if (!['GET', 'HEAD'].includes(init.method ?? 'GET')) {
        if (closing) check(cleanupWriteAllowed(target.pathname, init), 'cleanup_failed')
        else await lease()
      }
      if (target.pathname === '/mikka/api/auth/get-session') target.searchParams.set('disableCookieCache', 'true')
      if (signInAttempted && !originalCookie && headers.get('cookie')) originalCookie = headers.get('cookie')
      if (selectedWorkspaceId && target.pathname.startsWith('/mikka/api/organizations')) headers.set('x-mikka-workspace-id', selectedWorkspaceId)
      const helperRequest = ['team_selection', 'workspace_restore'].includes(phase)
      if (helperRequest) lastResponse = null
      let response
      try { response = await boundedFetch(target, { ...init, headers, redirect: 'error' }) }
      catch (error) {
        if (helperRequest) {
          lastResponse = { step: phase, httpStatus: null, body: closedBody(null, 'transport') }
          report.responses.push(lastResponse)
        }
        throw error
      }
      if (helperRequest) {
        let body
        try { body = closedBody(await responseBody(response.clone())) }
        catch (error) { body = error instanceof ProbeError ? error.body : closedBody(null, 'unavailable') }
        lastResponse = { step: phase, httpStatus: response.status, body }
        report.responses.push(lastResponse)
      }
      return response
    })
    await request('sign_in', '/api/auth/sign-in/email', post({ ...account, rememberMe: false }))
    const { body: identity } = await request('session', '/api/auth/get-session?disableCookieCache=true')
    check(identity?.user?.email?.toLowerCase() === account.email.toLowerCase() && typeof identity.user.id === 'string'
      && identity.user.id && typeof identity.session?.id === 'string' && identity.session.id && originalCookie, 'identity_failed')
    ownerId = identity.user.id; identitySessionId = identity.session.id
    if (recovery) {
      const old = recovery.journal
      const { body: settings } = await request('recovery_workspace', '/api/workspace')
      check(old.ownerHash === hash('owner', ownerId) && old.sessionIdHash !== hash('session', identitySessionId)
        && settings?.currentUserId === ownerId && Array.isArray(settings.choices)
        && [old.originalWorkspaceId, old.selectedWorkspaceId].every(id => settings.choices.some(row => row.id === id))
        && [old.originalWorkspaceId, old.selectedWorkspaceId].includes(settings.workspace?.id), 'recovery_scope_invalid')
      originalWorkspaceId = old.originalWorkspaceId; selectedWorkspaceId = old.selectedWorkspaceId
      const priorSessionIdHashes = [...new Set([old.sessionIdHash, ...old.priorSessionIdHashes])].sort()
      check(priorSessionIdHashes.length <= 8 && !priorSessionIdHashes.includes(hash('session', identitySessionId)), 'recovery_scope_invalid')
      journal = { ...old, driverAttempt: selected.driverRunAttempt, window: { commentId: selected.window.commentId,
        markerSha256: selected.window.markerSha256 }, sessionIdHash: hash('session', identitySessionId),
        priorSessionIdHashes, recoveryOf: recovery.reference }
      const { body: sessions } = await request('recovery_sessions', '/api/auth/list-sessions')
      check(Array.isArray(sessions) && sessions.length <= 100 && sessions.every(row => row?.userId === ownerId
        && typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 512), 'recovery_scope_invalid')
      for (const fingerprint of priorSessionIdHashes) {
        const matches = sessions.filter(row => hash('session', row.id) === fingerprint)
        check(matches.length <= 1, 'recovery_scope_invalid')
        if (!matches.length) continue
        const prior = matches[0]
        check(prior.id !== identitySessionId && typeof prior.token === 'string' && prior.token.length >= 32 && prior.token.length <= 512,
          'recovery_scope_invalid')
        oldSessions.push({ id: prior.id, token: prior.token }); allowedSessionTokens.add(prior.token)
      }
      await checkpoint('recovery_bound')
      report.recovery.priorSessionsAlreadyAbsent = priorSessionIdHashes.length - oldSessions.length
      createAttempted = true
      report.apiStatus = 'cleanup_ready'
    } else {
      phase = 'team_selection'; lastResponse = null
      const team = await selectTeam(client, { ownerId }, value => { originalWorkspaceId = value })
      selectedWorkspaceId = team?.workspaceId
      const { body: settings } = await request('selected_workspace', '/api/workspace')
      check(UUID.test(originalWorkspaceId ?? '') && UUID.test(selectedWorkspaceId ?? '')
        && settings?.currentUserId === ownerId && settings.workspace?.id === selectedWorkspaceId && settings.workspace.kind === 'team', 'identity_failed')
      report.checks.selectedTeamConfirmed = true
      const baseline = await listOrgs('organizations_before'), fixtureNonce = nonce()
      check(UUID.test(fixtureNonce), 'organization_binding_failed')
      journal = { schema: 1, purpose: 'mikka1856-owned-organization', applicationSha: selected.applicationSha,
        headSha: selected.headSha, driverRunId: selected.driverRunId, driverAttempt: selected.driverRunAttempt,
        window: { commentId: selected.window.commentId, markerSha256: selected.window.markerSha256 },
        ownerHash: hash('owner', ownerId), originalWorkspaceId, selectedWorkspaceId, sessionIdHash: hash('session', identitySessionId),
        priorSessionIdHashes: [], recoveryOf: null, nonce: fixtureNonce,
        baselineOrgHashes: baseline.map(row => hash('organization', row.id)).sort(), intentAt: new Date(now()).toISOString(),
        organizationId: null, organizationCreatedAt: null, ownershipVerified: false, emptyBindingsVerified: false,
        archiveIntent: false, archiveConfirmed: false }
      check(!baseline.some(row => allowedNames().includes(row.name)), 'organization_binding_failed')
      await checkpoint('create_intent')
      const { body: created } = await request('organization_create', '/api/organizations', post({ name: allowedNames()[0] }))
      check(UUID.test(created?.id ?? '') && created.name === allowedNames()[0] && created.role === 'owner'
        && !journal.baselineOrgHashes.includes(hash('organization', created.id)), 'organization_binding_failed')
      journal.organizationId = created.id; await checkpoint('candidate_recorded')
      await proveOwned()
      const path = '/api/organizations/' + journal.organizationId
      await checkpoint('rename_intent')
      const { body: renamed } = await request('organization_rename', path, { ...post({ name: allowedNames()[1] }), method: 'PATCH' })
      check(renamed?.organization?.id === journal.organizationId && renamed.organization.name === allowedNames()[1], 'organization_binding_failed')
      const { body: reread } = await request('organization_rename_readback', path)
      check(reread?.organization?.id === journal.organizationId && reread.organization.name === allowedNames()[1]
        && reread.organization.createdBy === ownerId && reread.role === 'owner', 'organization_binding_failed')
      await checkpoint('renamed')
      const { body: policy } = await request('organization_default_policy', path + '/policy')
      check(policy?.policy?.modelCredentialSharing === 'allow' && policy.policy.mcpSharing === 'allow'
        && policy.policy.allowedModelProviders === null && policy.policy.auditRetentionDays === null && policy.policy.legalHold === false
        && policy.policy.revision === 0 && Array.isArray(policy.approvals) && policy.approvals.length === 0)
      report.coverage.organization = 'owner_create_list_get_rename_default_policy_empty_identity'
      await checkpoint('audit_intent')
      const from = new Date(Date.parse(journal.organizationCreatedAt) - 1000).toISOString()
      // The server chooses until/createdAt, avoiding a runner clock ahead of the server.
      const { body: exported } = await request('audit_export_create', path + '/audit-log', post({ from }))
      const manifest = exported?.manifest
      check(manifest?.format === 'mikka-organization-audit-export' && manifest.version === 1
        && UUID.test(manifest.id ?? '') && manifest.organizationId === journal.organizationId
        && manifest.from === from && iso(manifest.createdAt) && manifest.until === manifest.createdAt && iso(manifest.expiresAt)
        && Date.parse(manifest.expiresAt) - Date.parse(manifest.createdAt) === 15 * 60_000
        && Number.isSafeInteger(manifest.count) && manifest.count >= 2 && manifest.count <= 1000
        && HASH.test(manifest.digest ?? '') && Array.isArray(exported.events) && verifyAuditExport(manifest, exported.events),
      'audit_integrity_failed')
      check(new Set(exported.events.map(row => row.id)).size === manifest.count
        && exported.events.every(row => UUID.test(row.id ?? '') && row.organizationId === journal.organizationId
        && row.actorId === ownerId && row.result === 'success')
        && exported.events.some(row => row.action === 'organization.created')
        && exported.events.some(row => row.action === 'organization.renamed' && row.targetId === journal.organizationId), 'audit_integrity_failed')
      const query = path + '/audit-log?exportId=' + manifest.id
      const { body: first } = await request('audit_export_page_1', query + '&offset=0&limit=1')
      check(object(first?.manifest) && auditDigest(first.manifest) === auditDigest(manifest)
        && Array.isArray(first.events) && first.events.length === 1 && first.nextOffset === 1, 'audit_integrity_failed')
      const { body: second } = await request('audit_export_page_2', query + '&offset=1&limit=1000')
      check(object(second?.manifest) && auditDigest(second.manifest) === auditDigest(manifest)
        && Array.isArray(second.events) && second.events.length === manifest.count - 1 && second.nextOffset === null
        && verifyAuditExport(manifest, [...first.events, ...second.events]), 'audit_integrity_failed')
      report.coverage.audit = 'real_owner_events_manifest_two_pages_integrity_verified'
      report.checks.audit = { count: manifest.count, pages: 2, digest: manifest.digest, expiresAt: manifest.expiresAt,
        archiveRetentionContract: 'audit_retained_export_expires' }
      await lease(); await checkpoint('business_passed')
      report.apiStatus = 'passed'
    }
  } catch (error) {
    report.failure = { step: phase, ...publicFailure(error, lastResponse) }
  } finally {
    // Independent budgets keep a slow Org completion from preventing session
    // cleanup. 180s business + 75s Org + 15s prior sessions + 30s restore + 30s
    // current-session closure leaves 30s within the six-minute workflow step.
    closing = true; cleanupDeadline = now() + 75_000
    // The pre-credential selection may register prior cleanup even when the
    // first live recheck refuses a moved source/window. This records an unpaid
    // obligation only; it never grants a read, session, or mutation permission.
    const preselectedCleanup = selection?.schema === 1 && selection?.purpose === 'governance-1608-followup-selection'
      && selection.selected === true && selection.window?.phase === 'cleanup'
    const organizationCleanupRequired = createAttempted || selected?.window?.phase === 'cleanup' || preselectedCleanup
    if (client && organizationCleanupRequired && intentJournaled) {
      await clean('organization_archive', archiveOwn)
      if (!report.cleanup.organizationArchived) {
        report.cleanup.unresolvedOrganization = true
        await clean('unresolved_journal', () => checkpoint('unresolved'))
      }
    } else if (organizationCleanupRequired) {
      report.cleanup.unresolvedOrganization = true
      report.cleanup.failures.push({ step: 'organization_scope', code: 'organization_unresolved', httpStatus: null, body: null })
    }
    cleanupDeadline = now() + 15_000
    if (client && recovery && intentJournaled) await clean('prior_sessions', async () => {
      for (const prior of oldSessions) {
        const { body } = await request('recovery_revoke_session', '/api/auth/revoke-session', post({ token: prior.token }))
        check(body?.status === true, 'cleanup_failed')
      }
      const { body: remaining } = await request('recovery_sessions_readback', '/api/auth/list-sessions')
      check(Array.isArray(remaining) && remaining.length <= 100 && remaining.every(row => row?.userId === ownerId && typeof row.id === 'string')
        && !remaining.some(row => journal.priorSessionIdHashes.includes(hash('session', row.id))), 'cleanup_failed')
      report.cleanup.priorSessionIdsAbsent = journal.priorSessionIdHashes.length
    })
    cleanupDeadline = now() + 30_000
    if (client && ownerId && originalWorkspaceId) await clean('workspace_restore', async () => {
      await restoreWorkspace(client, ownerId, originalWorkspaceId); report.cleanup.workspaceRestored = true
    })
    cleanupDeadline = now() + 30_000
    if (client && signInAttempted) {
      await clean('sign_out', async () => { await request('sign_out', '/api/auth/sign-out', post({})); report.cleanup.signOutAccepted = true })
      await clean('original_cookie', async () => {
        check(originalCookie, 'cleanup_failed')
        const { status, body } = await request('original_cookie_readback', '/api/auth/get-session?disableCookieCache=true',
          { headers: { cookie: originalCookie } }, [200, 401], true)
        check(status === 401 || status === 200 && body === null, 'cleanup_failed')
        report.cleanup.originalCookieRejected = true
      })
    }
    client?.clear(); originalCookie = ''; allowedSessionTokens.clear()
    for (const item of oldSessions) item.token = ''
    if (account) { account.email = ''; account.password = '' }
    report.cleanup.closed = report.cleanup.failures.length === 0 && (!organizationCleanupRequired || report.cleanup.organizationArchived === true)
      && (!signInAttempted || report.cleanup.signOutAccepted === true && report.cleanup.originalCookieRejected === true)
    if (journal && report.cleanup.closed) await clean('closed_journal', () => checkpoint('closed'))
    if (report.cleanup.failures.length) report.cleanup.closed = false
    report.cleanup.status = report.cleanup.closed ? 'passed' : 'failed'
    if (report.status !== 'not_selected') {
      report.scopeComplete = report.apiStatus === 'passed' && report.cleanup.closed
      report.status = report.scopeComplete ? 'passed' : report.apiStatus === 'cleanup_ready' && report.cleanup.closed ? 'cleanup_passed' : 'failed'
    }
    report.finishedAt = new Date(now()).toISOString()
  }
  return report
}

export const governanceProductionExitCode = report => ['not_selected', 'passed', 'cleanup_passed'].includes(report?.status) ? 0 : 1

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = 'self-hosted-production-report'
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let result, selecting = process.argv.includes('--select')
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    if (selecting) {
      result = await selectGovernanceProduction({ event })
      await writeFile(directory + '/governance-selection.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'selected=' + (result.selected === true) + '\n')
    } else {
      const selection = JSON.parse(await readFile(directory + '/governance-selection.json', 'utf8'))
      result = await runGovernanceProduction({ event, selection, writeReceipt: async envelope => {
        const line = JSON.stringify(envelope)
        const file = await open(directory + '/governance-journal.jsonl', 'a', 0o600)
        try { await file.write(line + '\n'); await file.sync() } finally { await file.close() }
        await new Promise((resolve, reject) => process.stdout.write(GOVERNANCE_JOURNAL_PREFIX + line + '\n', error => error ? reject(error) : resolve()))
      } })
    }
  } catch (error) {
    result = { schema: 1, kind: 'mikka1856-organization-owner-api', status: 'failed',
      fullEnterpriseAcceptance: false, failure: publicFailure(error) }
  }
  const text = JSON.stringify(result, null, 2) + '\n'
  await writeFile(directory + (selecting ? '/governance-selection.json' : '/governance.json'), text, { mode: 0o600 })
  if (!selecting) {
    console.log(text)
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      '## Disposable Organization owner / audit API receipt\n\n' + text + '\n')
  }
  process.exitCode = selecting ? result.selected === true || result.status === 'not_selected' ? 0 : 1 : governanceProductionExitCode(result)
}
