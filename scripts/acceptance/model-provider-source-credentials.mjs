#!/usr/bin/env node
/** Issue #1225 read-only source diagnosis. Existing identity and exact secret
 * names only; credentials remain in memory and never enter the report. */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AcceptanceError, CASES, publicFailure } from './model-provider-fallback.mjs'
import { runSourcePreflight } from './model-provider-source-preflight.mjs'

const INFISICAL = 'https://app.infisical.com'
const IDENTITY = '2cf9fa19-b9db-4c08-8ca0-b31859f2cbac'
const MIKKA_PROJECT = '89850d6a-f020-4936-863e-df77380dfe40'
const SOURCES = ['smoke', 'documented_test_vault']
const STATUSES = new Set(['observed', 'partial', 'ambiguous', 'blocked', 'failed'])
const CONNECTION_STATES = ['pending', 'connected', 'reconnect_required', 'disconnected', 'other']
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const text = value => typeof value === 'string' && value.length > 0
const count = value => Number.isSafeInteger(value) && value >= 0

class CredentialError extends Error {
  constructor(code, { httpStatus, status = 'blocked' } = {}) {
    super(code)
    this.status = status
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) this.httpStatus = httpStatus
  }
}
const check = (condition, code) => { if (!condition) throw new CredentialError(code) }
const invalidHelper = () => { throw new CredentialError('helper_report_invalid', { status: 'failed' }) }
function safeFailure(error) {
  if (error instanceof CredentialError) return { status: error.status, code: error.message,
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) }
  if (error instanceof AcceptanceError) return publicFailure(error)
  return { status: 'failed', code: 'source_preflight_failed' }
}
function helperFailure(value) {
  if (value.code === 'workspace_limit') return { code: 'workspace_limit' }
  if (value.code === undefined) return {}
  const projected = publicFailure(new AcceptanceError(value.code, 'blocked', {
    httpStatus: value.httpStatus, serverCode: value.serverCode,
  }))
  return { code: projected.code,
    ...(projected.httpStatus === undefined ? {} : { httpStatus: projected.httpStatus }),
    ...(projected.serverCode === undefined ? {} : { serverCode: projected.serverCode }) }
}
function counts(value, names) {
  if (!value || names.some(name => !count(value[name]))) invalidHelper()
  return Object.fromEntries(names.map(name => [name, value[name]]))
}
function projectWorkspace(value) {
  if (!value || !Number.isSafeInteger(value.ordinal) || value.ordinal < 1 || value.ordinal > 10
    || value.ownerMatched !== true || !STATUSES.has(value.status)) invalidHelper()
  const result = { ordinal: value.ordinal, ownerMatched: true, status: value.status, ...helperFailure(value) }
  if (value.status !== 'observed') return result
  if (!['cloud', 'local', 'unknown'].includes(value.location) || typeof value.cloudReady !== 'boolean'
    || !Array.isArray(value.cases) || value.cases.length !== CASES.length) invalidHelper()
  const ownSubscriptions = Object.fromEntries(['claude', 'codex'].map(provider => {
    const entry = value.ownSubscriptions?.[provider]
    return [provider, { ...counts(entry, ['total', 'paused', 'connectedUnpaused']),
      states: counts(entry?.states, CONNECTION_STATES) }]
  }))
  return { ...result,
    ...counts(value, ['candidateCount', 'orderEntryCount', 'candidateOwnerFieldPresent', 'candidateOwnerMatched']),
    location: value.location, cloudReady: value.cloudReady,
    ownApiKeys: counts(value.ownApiKeys, ['total', 'deepseek']), ownSubscriptions,
    cases: CASES.map(item => {
      const matching = value.cases.filter(row => row?.case === item.id && row.model === item.model)
      if (matching.length !== 1) invalidHelper()
      const row = matching[0]
      return { case: item.id, model: item.model, ...counts(row, ['ownSourcePool', 'offeredForHarnessAndKind']),
        counts: counts(row.counts, ['exactModel', 'harnessAndKind', 'ownSourceId', 'credentialOwnerMatch']) }
    }),
  }
}
function projectHelper(value, source, revision) {
  if (!value || value.issue !== 1225 || value.purpose !== 'source_preflight'
    || value.credentialSource !== source || value.revision !== revision || !STATUSES.has(value.status)
    || value.not_called_models !== true || value.not_created_fixtures !== true
    || value.workspaceScope !== 'current_default_workspace_own_bots'
    || typeof value.ownerVerified !== 'boolean' || !count(value.ownedWorkspaceCount) || value.workspaceLimit !== 10
    || !Array.isArray(value.workspaces) || value.workspaces.length > 10
    || typeof value.versionPin?.start !== 'boolean' || typeof value.versionPin?.end !== 'boolean'
    || typeof value.sessionClosed !== 'boolean') invalidHelper()
  if (value.status === 'observed' && (!value.ownerVerified || !value.sessionClosed
    || !value.versionPin.start || !value.versionPin.end || !value.workspaces.length
    || value.workspaces.length !== value.ownedWorkspaceCount)) invalidHelper()
  return { issue: 1225, purpose: 'source_preflight', credentialSource: source, revision,
    status: value.status, ...helperFailure(value), not_called_models: true, not_created_fixtures: true,
    workspaceScope: 'current_default_workspace_own_bots', ownerVerified: value.ownerVerified,
    ownedWorkspaceCount: value.ownedWorkspaceCount, workspaceLimit: 10,
    workspaces: value.workspaces.map(projectWorkspace),
    versionPin: { start: value.versionPin.start, end: value.versionPin.end }, sessionClosed: value.sessionClosed }
}

/** The injected helper is for unit isolation; the CLI always uses the ordinary
 * owner HTTP preflight, which performs no model or fixture operations. */
export async function runCredentialSourcePreflight({
  env = process.env, fetchImpl = fetch, sourcePreflight = runSourcePreflight,
} = {}) {
  const revision = sha(env.MIKKA_EXPECTED_DEPLOYMENT_SHA) ? env.MIKKA_EXPECTED_DEPLOYMENT_SHA : null
  const report = { issue: 1225, purpose: 'credential_source_preflight', revision,
    not_called_models: true, not_created_fixtures: true, status: 'blocked', sources: [] }
  let phase = 'scope', token = ''
  async function request(url, { method = 'GET', headers = {}, body } = {}) {
    let response
    try {
      response = await fetchImpl(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch { throw new CredentialError('request_failed') }
    // Refusal bodies are never parsed or forwarded, even if they resemble secrets.
    if (!response.ok) throw new CredentialError('http_refused', { httpStatus: response.status })
    const value = await response.json().catch(() => null)
    check(value && typeof value === 'object' && !Array.isArray(value), 'response_invalid')
    return value
  }
  const authorized = url => request(url, { headers: { authorization: 'Bearer ' + token } })
  async function readSecret(projectId, environment, secretPath, name) {
    const url = new URL('/api/v4/secrets/' + name, INFISICAL)
    url.search = new URLSearchParams({ projectId, environment, secretPath, type: 'shared',
      includeImports: 'false', expandSecretReferences: 'false', viewSecretValue: 'true' }).toString()
    const value = (await authorized(url)).secret
    check(value && typeof value === 'object' && value.secretKey === name, 'credential_response_invalid')
    check(value.secretValueHidden !== true, 'credential_hidden')
    check((value.secretValueHidden === undefined || value.secretValueHidden === false)
      && text(value.secretValue)
      && (value.workspace === undefined || value.workspace === projectId)
      && (value.environment === undefined || value.environment === environment)
      && (value.secretPath === undefined || value.secretPath === secretPath)
      && (value.type === undefined || value.type === 'shared'), 'credential_response_invalid')
    return value.secretValue
  }
  async function diagnose(source) {
    let sourcePhase = source === 'smoke' ? 'smoke_email' : 'vault_projects'
    let email = '', password = ''
    try {
      if (source === 'smoke') {
        email = await readSecret(MIKKA_PROJECT, 'prod', '/', 'SMOKE_OWNER_EMAIL')
        sourcePhase = 'smoke_password'
        password = await readSecret(MIKKA_PROJECT, 'prod', '/', 'SMOKE_OWNER_PASSWORD')
      } else {
        const url = new URL('/api/v1/projects?includeRoles=false', INFISICAL)
        const value = await authorized(url)
        check(Array.isArray(value.projects) && value.projects.every(row => row && typeof row === 'object'), 'response_invalid')
        const matches = value.projects.filter(row => row.name === 'Mikka Test Account Vault')
        check(matches.length > 0, 'vault_not_visible')
        check(matches.length === 1, 'vault_ambiguous')
        const projectId = matches[0].id
        check(text(projectId) && projectId.length <= 128, 'response_invalid')
        sourcePhase = 'vault_email'
        email = await readSecret(projectId, 'dev', '/test-account', 'MIKKA_TEST_ACCOUNT_EMAIL')
        sourcePhase = 'vault_password'
        password = await readSecret(projectId, 'dev', '/test-account', 'MIKKA_TEST_ACCOUNT_PASSWORD')
      }
      sourcePhase = 'application_preflight'
      const sourceEnv = { ...env, MIKKA_SOURCE_PREFLIGHT_SOURCE: source,
        ...(source === 'smoke' ? { SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: password }
          : { MIKKA_SOURCE_PREFLIGHT_EMAIL: email, MIKKA_SOURCE_PREFLIGHT_PASSWORD: password }) }
      const preflight = projectHelper(await sourcePreflight({ env: sourceEnv, fetchImpl }), source, revision)
      return { source, status: preflight.status, phase: sourcePhase, preflight }
    } catch (error) { return { source, phase: sourcePhase, ...safeFailure(error) } }
    finally { email = ''; password = '' }
  }
  try {
    check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
      && env.GITHUB_REF === 'refs/heads/fix/1225-source-preflight', 'scope_rejected')
    check(revision !== null, 'configuration_required')
    phase = 'github_oidc'
    let oidcUrl
    try { oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL) } catch { throw new CredentialError('oidc_unavailable') }
    check(oidcUrl.protocol === 'https:' && oidcUrl.hostname.endsWith('.actions.githubusercontent.com')
      && !oidcUrl.username && !oidcUrl.password && !oidcUrl.hash
      && text(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) && !/[\r\n]/.test(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN), 'oidc_unavailable')
    oidcUrl.searchParams.set('audience', 'mikka-infisical')
    let jwt = (await request(oidcUrl, { headers: { authorization: 'Bearer ' + env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } })).value
    check(text(jwt), 'response_invalid')
    phase = 'infisical_login'
    const login = await request(new URL('/api/v1/auth/oidc-auth/login', INFISICAL), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: { identityId: IDENTITY, jwt },
    })
    jwt = ''
    check(text(login.accessToken) && !/[\r\n]/.test(login.accessToken)
      && login.tokenType === 'Bearer', 'response_invalid')
    token = login.accessToken
    for (const source of SOURCES) report.sources.push(await diagnose(source))
    report.status = report.sources.every(row => row.status === 'observed') ? 'observed'
      : report.sources.some(row => ['observed', 'partial', 'ambiguous'].includes(row.status)) ? 'partial'
        : report.sources.some(row => row.status === 'failed') ? 'failed' : 'blocked'
  } catch (error) {
    const failure = safeFailure(error)
    Object.assign(report, failure, { phase })
    report.sources = SOURCES.map(source => ({ source, phase, ...failure }))
  } finally { token = '' }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await runCredentialSourcePreflight()
    const directory = resolve('model-provider-source-report')
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify(report))
    if (report.status !== 'observed') process.exitCode = 1
  } catch {
    console.error(JSON.stringify({ issue: 1225, purpose: 'credential_source_preflight',
      status: 'failed', code: 'report_write_failed' }))
    process.exitCode = 1
  }
}
