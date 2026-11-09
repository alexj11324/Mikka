import { createHash } from 'node:crypto'

// One-off, explicitly authorized #1505 fixture. Importing this file does not
// load application credentials, connect to a database, or execute setup.
export const SMOKE_USER_ID = 'cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3'
export const OWNER_USER_ID = 'XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ'
export const GITHUB_ACCOUNT_ID = '183887963'
export const GITHUB_LOGIN = 'alexj11324'
export const REPOSITORY = 'alexj11324/Mikka-handoff'
export const OWNER_MIN_VALIDITY_MS = 4 * 60 * 60_000
const SCOPED_MIN_VALIDITY_MS = 2 * 60 * 60_000
export const PERMISSIONS = Object.freeze({ metadata: 'read', contents: 'read' })
const API = 'https://api.github.com'
const digest = value => createHash('sha256').update(value).digest('hex')
const validId = value => /^(?:[1-9]\d*)$/.test(String(value)) && (typeof value !== 'number' || Number.isSafeInteger(value))
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Only closed, locally chosen codes/statuses reach errors. Database/provider
// exceptions can contain credentials in request/query parameters, so their raw
// messages, bodies and causes must never enter the runner's log or state file.
export class SmokeGitHubSetupError extends Error {
  constructor(code, details = {}, options) {
    super(`issue1505_github_${code}`, options)
    this.name = 'SmokeGitHubSetupError'
    this.code = code
    this.details = details
  }
  toJSON() { return { code: this.code, details: this.details } }
}
const fail = (code, details) => { throw new SmokeGitHubSetupError(code, details) }

function identity(value, stage) {
  if (!object(value) || String(value.id) !== GITHUB_ACCOUNT_ID || value.login !== GITHUB_LOGIN || value.type !== 'User') fail('identity_mismatch', { stage })
}

/** Production setup and the issue-owned rotation runner supply the application's
 * existing credential, sealing and connection functions; tests inject fakes.
 * Returned state has public IDs, timestamps and a one-way random-token digest;
 * no access token, refresh token, client secret or sealed credential is exposed.
 */
export function createSmokeGitHubFixture({ application, appId, fetchImpl = fetch, now = Date.now }) {
  if (!application?.clientId || !application?.clientSecret || (appId && !validId(appId))) fail('app_not_configured')
  let resolvedAppId = appId ? String(appId) : null
  const basic = `Basic ${Buffer.from(`${application.clientId}:${application.clientSecret}`).toString('base64')}`

  async function request(path, { token, method = 'GET', body, stage, appAuth = false, expected = 200 } = {}) {
    let response
    try {
      response = await fetchImpl(API + path, {
        method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Mikka-Issue-1505-ReadOnly-Fixture',
          authorization: appAuth ? basic : `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) { throw new SmokeGitHubSetupError('provider_transport', { stage }, { cause: error }) }
    if (response.status !== expected) {
      await response.body?.cancel().catch(() => {})
      fail('provider_http', { stage, status: response.status })
    }
    if (expected === 204) return { data: null, next: false }
    let data
    try { data = await response.json() } catch { fail('provider_schema', { stage }) }
    if (!object(data)) fail('provider_schema', { stage })
    return { data, next: /rel="next"/.test(response.headers.get('link') ?? '') }
  }

  async function verifyRepositories(token, scoped, expectedRepositoryId) {
    const stage = scoped ? 'scoped_installations' : 'owner_installations'
    let found = null, listedRepositoryCount = 0, otherRepositoryMetadataCount = 0
    for (let page = 1; ; page++) {
      if (page > 20) fail('pagination_limit', { stage })
      const result = await request(`/user/installations?per_page=100&page=${page}`, { token, stage })
      if (!Array.isArray(result.data.installations)) fail('provider_schema', { stage })
      for (const installation of result.data.installations) {
        if (!object(installation) || !validId(installation.app_id) || !validId(installation.id)) fail('provider_schema', { stage })
        if (String(installation.app_id) !== resolvedAppId || installation.suspended_at != null) continue
        if (installation.client_id != null && installation.client_id !== application.clientId) fail('scoped_app_mismatch')
        for (let repoPage = 1; ; repoPage++) {
          if (repoPage > 20) fail('pagination_limit', { stage })
          const repos = await request(`/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`, { token, stage })
          if (!Array.isArray(repos.data.repositories)) fail('provider_schema', { stage })
          for (const repo of repos.data.repositories) {
            if (!object(repo) || !validId(repo.id) || typeof repo.full_name !== 'string') fail('provider_schema', { stage })
            listedRepositoryCount++
            // This endpoint lists the authenticated user's explicit repository
            // access for an installation. Its directory is not documented as a
            // scoped-token allowlist, and production returns extra metadata.
            // Scope comes from our exact mint request + authorization response.
            if (repo.full_name !== REPOSITORY) { otherRepositoryMetadataCount++; continue }
            if (found || String(repo.id) !== expectedRepositoryId || installation.account?.login !== GITHUB_LOGIN || String(installation.account?.id) !== GITHUB_ACCOUNT_ID) fail('repository_mismatch', { stage })
            found = { repositoryId: String(repo.id), installationId: String(installation.id) }
          }
          if (!repos.next) break
        }
      }
      if (!result.next) break
    }
    if (!found) fail('repository_unavailable', { stage })
    return { ...found, listedRepositoryCount, otherRepositoryMetadataCount }
  }

  async function verifyAndDiscoverApp(token) {
    const { data } = await request(`/applications/${encodeURIComponent(application.clientId)}/token`, {
      method: 'POST', appAuth: true, body: { access_token: token }, stage: 'check_owner_token',
    })
    if (data.app?.client_id !== application.clientId) fail('scoped_app_mismatch')
    // GitHub's authorization schema makes user optional; live /user has already
    // verified the actual identity. Any returned user must agree with it.
    if (data.user != null) identity(data.user, 'check_owner_token')
    // The official app object guarantees client_id, not a numeric app.id.
    if (data.app.id != null) {
      if (!validId(data.app.id) || (resolvedAppId && resolvedAppId !== String(data.app.id))) fail('scoped_app_mismatch')
      resolvedAppId = String(data.app.id)
    }
    if (resolvedAppId) return data.expires_at ?? null
    const candidates = new Set()
    for (let page = 1; ; page++) {
      if (page > 20) fail('pagination_limit', { stage: 'discover_app' })
      const result = await request(`/user/installations?per_page=100&page=${page}`, { token, stage: 'discover_app' })
      if (!Array.isArray(result.data.installations)) fail('provider_schema', { stage: 'discover_app' })
      for (const installation of result.data.installations) {
        if (installation?.client_id !== application.clientId) continue
        if (!validId(installation.app_id)) fail('provider_schema', { stage: 'discover_app' })
        candidates.add(String(installation.app_id))
      }
      if (!result.next) break
    }
    if (candidates.size !== 1) fail('app_discovery_ambiguous')
    resolvedAppId = [...candidates][0]
    return data.expires_at ?? null
  }

  async function verifyRepository(token, stage) {
    const { data } = await request(`/repos/${REPOSITORY}`, { token, stage })
    if (!validId(data.id) || data.full_name !== REPOSITORY || data.archived !== false || data.disabled === true) fail('repository_unavailable', { stage })
    return String(data.id)
  }

  function verifyScopedAuthorization(data, stage, requireScope) {
    if (data.app?.client_id !== application.clientId) fail('scoped_app_mismatch')
    if (data.scopes != null && (!Array.isArray(data.scopes) || data.scopes.length !== 0)) fail('unexpected_oauth_scopes')
    if (data.user != null) identity(data.user, stage)
    // Check-token's shared authorization schema permits absent installation;
    // the original scoped mint response must always establish selected scope.
    if (data.installation == null && !requireScope) return false
    if (data.installation?.repository_selection !== 'selected') fail('scope_not_selected')
    const actualPermissions = data.installation?.permissions
    if (!object(actualPermissions) || Object.keys(actualPermissions).some(key => actualPermissions[key] !== 'none' && actualPermissions[key] !== PERMISSIONS[key]) ||
        Object.keys(PERMISSIONS).some(key => actualPermissions[key] !== PERMISSIONS[key])) fail('scope_permissions_mismatch')
    if (data.installation.account != null) identity(data.installation.account, stage)
    return true
  }

  async function revoke(token) {
    // Deliberately DELETE /token, never /grant (which affects all authorizations).
    await request(`/applications/${encodeURIComponent(application.clientId)}/token`, {
      method: 'DELETE', appAuth: true, body: { access_token: token }, expected: 204, stage: 'revoke_scoped_token',
    })
  }

  /** Only this exact token is addressed. A failed DELETE is not success: an
   * authenticated Check-token 404 must establish that it is already invalid. */
  async function revokeConfirmed(token) {
    try { await revoke(token); return { kind: 'delete_token', status: 204 } }
    catch (error) {
      try {
        await request(`/applications/${encodeURIComponent(application.clientId)}/token`, {
          method: 'POST', appAuth: true, body: { access_token: token }, expected: 404, stage: 'check_revoked_token',
        })
        return { kind: 'authenticated_check_token', status: 404 }
      } catch (checkError) { throw new SmokeGitHubSetupError('revoke_scoped_token_failed', { stage: 'revoke_scoped_token' }, { cause: new AggregateError([error, checkError]) }) }
    }
  }

  /** Preparation only: never saves a connection. The returned token remains
   * inside the operator process. onMint receives it before later validation so
   * every failure can revoke only this new child. Default setup keeps its 4h
   * source requirement; the explicit rotation may use a still-valid source. */
  async function prepareChild(source, { minimumSourceValidityMs = OWNER_MIN_VALIDITY_MS, requireSourceProviderExpiry = false,
    onSourceChecked, onMint, stage = () => {} } = {}) {
    const sourceExpiry = source?.expiresAt == null ? null : new Date(source.expiresAt).getTime()
    if (!Number.isFinite(minimumSourceValidityMs) || minimumSourceValidityMs < 600_000
      || !source?.token || source.githubAccountId !== GITHUB_ACCOUNT_ID
      || (sourceExpiry !== null && (!Number.isFinite(sourceExpiry) || sourceExpiry <= now() + minimumSourceValidityMs))) fail('owner_credential_invalid')
    const sourceToken = source.token
    identity((await request('/user', { token: sourceToken, stage: 'owner_identity' })).data, 'owner_identity')
    const checkedSourceExpiry = await verifyAndDiscoverApp(sourceToken)
    if (requireSourceProviderExpiry) {
      const expiry = Date.parse(checkedSourceExpiry)
      if (!Number.isFinite(expiry) || expiry <= now() + minimumSourceValidityMs) fail('owner_provider_expiry_invalid')
      await onSourceChecked?.({ providerExpiresAt: new Date(expiry).toISOString(), checkedAt: new Date(now()).toISOString() })
    }
    const repositoryId = await verifyRepository(sourceToken, 'owner_repository')
    const sourceRepository = await verifyRepositories(sourceToken, false, repositoryId)
    await stage('mint_scoped_token')
    const minted = (await request(`/applications/${encodeURIComponent(application.clientId)}/token/scoped`, {
      method: 'POST', appAuth: true, stage: 'mint_scoped_token',
      body: { access_token: sourceToken, target: GITHUB_LOGIN, repositories: [REPOSITORY.split('/')[1]], permissions: PERMISSIONS },
    })).data
    if (typeof minted.token !== 'string' || !minted.token || minted.token === sourceToken) fail('scoped_token_not_distinct')
    await onMint?.(minted.token)
    verifyScopedAuthorization(minted, 'scoped_response_identity', true)
    let providerExpiry = Date.parse(minted.expires_at)
    if (!Number.isFinite(providerExpiry) || providerExpiry <= now() + SCOPED_MIN_VALIDITY_MS) fail('scoped_expiry_invalid')
    identity((await request('/user', { token: minted.token, stage: 'scoped_identity' })).data, 'scoped_identity')
    const confirmation = (await request(`/applications/${encodeURIComponent(application.clientId)}/token`, {
      method: 'POST', appAuth: true, body: { access_token: minted.token }, stage: 'check_scoped_token',
    })).data
    if (typeof confirmation.token === 'string' && confirmation.token && confirmation.token !== minted.token) fail('scoped_token_mismatch')
    const checkTokenScopeConfirmed = verifyScopedAuthorization(confirmation, 'check_scoped_token', false)
    if (confirmation.expires_at != null) {
      const checkedExpiry = Date.parse(confirmation.expires_at)
      if (!Number.isFinite(checkedExpiry) || checkedExpiry <= now() + SCOPED_MIN_VALIDITY_MS) fail('scoped_expiry_invalid')
      providerExpiry = Math.min(providerExpiry, checkedExpiry)
    }
    if (await verifyRepository(minted.token, 'scoped_repository') !== repositoryId) fail('repository_mismatch', { stage: 'scoped_repository' })
    const scopedRepository = await verifyRepositories(minted.token, true, repositoryId)
    if (scopedRepository.installationId !== sourceRepository.installationId) fail('repository_mismatch', { stage: 'scoped_installations' })
    return { token: minted.token, providerExpiry, tokenSha256: digest(minted.token),
      metadata: { githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN, repository: REPOSITORY,
        appId: resolvedAppId, appClientId: application.clientId, ...scopedRepository, checkTokenScopeConfirmed, providerExpiresAt: new Date(providerExpiry).toISOString() } }
  }
  return { prepareChild, revokeConfirmed, clientId: application.clientId }
}
