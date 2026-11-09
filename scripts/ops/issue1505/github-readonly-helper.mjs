import { createHash } from 'node:crypto'
import { SmokeGitHubSetupError, SMOKE_USER_ID, OWNER_USER_ID, GITHUB_ACCOUNT_ID, GITHUB_LOGIN, REPOSITORY } from './github-readonly-provider.mjs'

export const digest = value => createHash('sha256').update(value).digest('hex')
export const fail = code => { throw new Error('issue1505_github_' + code) }
export const check = (condition, code) => { if (!condition) fail(code) }
const SAFE_CODES = new Set([
  "app_configuration_changed",
  "app_discovery_ambiguous",
  "app_not_configured",
  "arguments_invalid",
  "child_digest_mismatch",
  "child_not_distinct",
  "cleanup_token_mismatch",
  "cleanup_token_unavailable",
  "dependency_failed",
  "execution_not_enabled",
  "identity_mismatch",
  "invalid_state",
  "normal_readback_mismatch",
  "output_overwrites_input",
  "owner_connection_changed",
  "owner_credential_invalid",
  "owner_provider_expiry_invalid",
  "owner_source_not_fresh",
  "pagination_limit",
  "principal_mismatch",
  "provider_http",
  "provider_schema",
  "provider_transport",
  "provider_validity_insufficient",
  "repository_mismatch",
  "repository_unavailable",
  "revoke_scoped_token_failed",
  "scope_not_selected",
  "scope_permissions_mismatch",
  "scoped_app_mismatch",
  "scoped_expiry_invalid",
  "scoped_token_mismatch",
  "scoped_token_not_distinct",
  "smoke_connection_changed",
  "smoke_connection_exists",
  "smoke_legacy_github_exists",
  "smoke_work_active",
  "state_bytes_changed",
  "stored_credential_invalid",
  "stored_identity_invalid",
  "unexpected_oauth_scopes",
  "verified_app_id_invalid"
].map(code => 'issue1505_github_' + code))
export const safeCode = error => SAFE_CODES.has(error?.message) ? error.message : 'issue1505_github_dependency_failed'

const PROVIDER_FAILURE_STAGES = new Set([
  'owner_identity', 'check_owner_token', 'discover_app', 'owner_repository',
  'owner_installations', 'owner_installation_repositories', 'mint_scoped_token',
  'scoped_identity', 'check_scoped_token', 'scoped_repository',
  'scoped_installations', 'scoped_installation_repositories',
  'revoke_scoped_token', 'check_revoked_token',
])
/** Copy only a locally chosen request phase and a valid HTTP status. Never
 * serialize provider error details, response bodies, URLs, headers or causes. */
export function safeProviderFailure(error) {
  if (!(error instanceof SmokeGitHubSetupError)
    || !['provider_http', 'provider_transport', 'provider_schema'].includes(error.code)
    || safeCode(error) !== 'issue1505_github_' + error.code
    || !PROVIDER_FAILURE_STAGES.has(error.details?.stage)) return undefined
  const stage = error.details.stage
  if (error.code !== 'provider_http') return { stage }
  const status = error.details.status
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined
  return { stage, status }
}
const integerId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)
const finiteDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value))

export function validateState(state) {
  check(state?.version === 1 && state.issue === 1505 && state.userId === SMOKE_USER_ID && state.ownerUserId === OWNER_USER_ID
    && state.githubAccountId === GITHUB_ACCOUNT_ID && state.githubLogin === GITHUB_LOGIN && state.repository === REPOSITORY
    && typeof state.appClientId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(state.appClientId)
    && integerId(state.appId) && integerId(state.repositoryId) && integerId(state.installationId)
    && /^[a-f0-9]{64}$/.test(state.tokenSha256 ?? '') && finiteDate(state.providerExpiresAt)
    && finiteDate(state.connectionExpiresAt) && finiteDate(state.connectionUpdatedAt)
    && Date.parse(state.connectionExpiresAt) <= Date.parse(state.providerExpiresAt), 'invalid_state')
  return state
}
export function stateFor(prepared, stored) {
  return validateState({ version: 1, issue: 1505, userId: SMOKE_USER_ID, ownerUserId: OWNER_USER_ID,
    githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN, repository: REPOSITORY,
    appId: prepared.metadata.appId, appClientId: prepared.metadata.appClientId, repositoryId: prepared.metadata.repositoryId, installationId: prepared.metadata.installationId,
    tokenSha256: prepared.tokenSha256, providerExpiresAt: new Date(prepared.providerExpiry).toISOString(),
    connectionExpiresAt: stored.expiresAt, connectionUpdatedAt: stored.updatedAt })
}
export function lifetime(providerExpiry, now = Date.now()) {
  check(Number.isFinite(providerExpiry) && providerExpiry > now + 2 * 60 * 60_000, 'provider_validity_insufficient')
  return Math.floor((Math.min(providerExpiry, now + 4 * 60 * 60_000) - 10_000 - now) / 1000)
}
export function assertRepositoryReadback(result, state) {
  const repository = result?.repositories?.find(row => row.fullName === REPOSITORY)
  check(result?.githubAccountId === GITHUB_ACCOUNT_ID && result.login === GITHUB_LOGIN
    && repository?.id === state.repositoryId && repository.installationId === state.installationId, 'normal_readback_mismatch')
  return { connected: true, samePrincipal: true, repositoryAccessible: true, sameAppInstallation: true }
}

/** Resolve the existing Owner connection normally, then mint only a new read-only child for Smoke. */
export async function prepareReadOnlyConnection({ store, provider, checkpoint = async () => {}, now = Date.now }) {
  const report = { version: 1, issue: 1505, operation: 'prepare', status: 'incomplete', stage: 'identity',
    startedAt: new Date(now()).toISOString(), changed: false, ownerRefreshAttempted: false, mintAttempted: false }
  let source, token, prepared, committed = false, commitAttempted = false
  const save = async stage => { report.stage = stage; await checkpoint(report) }
  try {
    await save('identity')
    await store.identity()
    await store.idle()
    await store.assertVacant()
    await save('prepare_owner_source')
    const before = await store.prepareOwnerSource(async () => {
      report.ownerRefreshAttempted = true
      report.ownerTokenResolution = { minimumValidityMs: 660000, status: 'attempting', actualRefresh: 'not_independently_observed' }
      await save('prepare_owner_source')
    })
    report.ownerTokenResolution.status = 'committed'
    await save('read_owner_no_refresh')
    source = await store.ownerSourceNoRefresh()
    report.ownerSourceBaseline = 'after_normal_token_resolution'
    report.ownerTokenResolution.beforeUpdatedAt = before.updatedAt
    report.ownerTokenResolution.beforeExpiresAt = before.expiresAt
    report.ownerTokenResolution.afterUpdatedAt = source.metadata.updatedAt
    report.ownerTokenResolution.afterExpiresAt = source.metadata.expiresAt
    report.ownerTokenResolution.persistedMetadataChanged = before.updatedAt !== source.metadata.updatedAt || before.expiresAt !== source.metadata.expiresAt
    await save('mint_readonly_child')
    prepared = await provider.prepareChild(source, {
      minimumSourceValidityMs: 600_000, requireSourceProviderExpiry: true,
      onSourceChecked: value => { report.ownerProviderExpiresAt = value.providerExpiresAt },
      stage: async stage => { if (stage === 'mint_scoped_token') { report.mintAttempted = true; report.mintOutcome = 'unknown'; await save('mint_request') } },
      onMint: value => { check(value !== source.token, 'child_not_distinct'); token = value; report.mintOutcome = 'received'; report.mintedTokenSha256 = digest(value) },
    })
    check(token === prepared.token && prepared.tokenSha256 === digest(token), 'child_digest_mismatch')
    report.minted = { tokenSha256: prepared.tokenSha256, providerExpiresAt: new Date(prepared.providerExpiry).toISOString(),
      appId: prepared.metadata.appId, repositoryId: prepared.metadata.repositoryId, installationId: prepared.metadata.installationId,
      permissions: { metadata: 'read', contents: 'read' }, mintScopeConfirmed: true,
      checkTokenScopeConfirmed: prepared.metadata.checkTokenScopeConfirmed === true }
    await save('install_vacant_connection')
    const state = await store.install(source, prepared, async state => {
      report.state = state
      await save('commit_new_child')
      commitAttempted = true
    })
    committed = true; report.changed = true; report.state = state
    await save('normal_repository_readback')
    report.readback = assertRepositoryReadback(await store.listRepositories(state.appId), state)
    await store.assertOwnerUnchanged(source)
    await store.idle()
    report.ownerUnchanged = true; report.status = 'passed'
  } catch (error) {
    report.code = safeCode(error)
    const providerFailure = safeProviderFailure(error)
    if (providerFailure) report.providerFailure = providerFailure
    if (commitAttempted && !committed) {
      // The safe state was persisted before COMMIT. Never revoke a possibly installed token.
      report.commitUnconfirmed = true; report.changed = null
    } else if (token) {
      try {
        if (committed) {
          report.cleanup = await cleanupReadOnlyConnection({ store, provider, state: report.state, token, checkpoint: async value => {
            report.cleanup = value; await checkpoint(report)
          }, now })
          if (report.cleanup.status === 'passed') report.changed = false
        } else {
          report.newChildRevocation = await provider.revokeConfirmed(token)
        }
      } catch (cleanupError) {
        report.cleanup = { status: 'incomplete', code: safeCode(cleanupError) }
      }
    }
  } finally {
    source = undefined; token = undefined; prepared = undefined
    report.completedAt = new Date(now()).toISOString()
    await checkpoint(report)
  }
  return report
}

/** Recovery takes only the exact nonsecret state produced before installing this child. */
export async function cleanupReadOnlyConnection({ store, provider, state, token, checkpoint = async () => {}, now = Date.now }) {
  const report = { version: 1, issue: 1505, operation: 'cleanup', status: 'incomplete', stage: 'state',
    startedAt: new Date(now()).toISOString(), revoked: false, disconnected: false }
  try {
    validateState(state); check(state.appClientId === provider.clientId, 'app_configuration_changed'); await checkpoint(report)
    await store.identity(); await store.idle()
    report.stage = 'match_owned_child'
    const observed = await store.matchingToken(state)
    if (token !== undefined) check(digest(token) === state.tokenSha256, 'cleanup_token_mismatch')
    else token = observed
    check(typeof token === 'string' && digest(token) === state.tokenSha256, 'cleanup_token_unavailable')
    report.stage = 'revoke_exact_child'; await checkpoint(report)
    report.revocation = await provider.revokeConfirmed(token); report.revoked = true
    report.stage = 'disconnect_exact_child'; await checkpoint(report)
    await store.disconnectMatching(state)
    report.disconnected = true; report.status = 'passed'
  } catch (error) {
    report.code = safeCode(error)
    const providerFailure = safeProviderFailure(error)
    if (providerFailure) report.providerFailure = providerFailure
  }
  finally { token = undefined; report.completedAt = new Date(now()).toISOString(); await checkpoint(report) }
  return report
}
