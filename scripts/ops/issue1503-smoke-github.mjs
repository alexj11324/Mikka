import { createHash } from 'node:crypto'

// One-off, explicitly authorized #1503 fixture. Importing this file does not
// load application credentials, connect to a database, or execute setup.
export const SMOKE_USER_ID = 'cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3'
export const OWNER_USER_ID = 'XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ'
export const GITHUB_ACCOUNT_ID = '183887963'
export const GITHUB_LOGIN = 'alexj11324'
export const REPOSITORY = 'alexj11324/Mikka-handoff'
export const OWNER_MIN_VALIDITY_MS = 4 * 60 * 60_000
const LOCAL_MAX_VALIDITY_MS = 4 * 60 * 60_000
const SCOPED_MIN_VALIDITY_MS = 2 * 60 * 60_000
const EXPIRY_MARGIN_MS = 10_000
const PERMISSIONS = Object.freeze({ metadata: 'read', contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', actions: 'read' })
const API = 'https://api.github.com'
const digest = value => createHash('sha256').update(value).digest('hex')
const validId = value => /^(?:[1-9]\d*)$/.test(String(value)) && (typeof value !== 'number' || Number.isSafeInteger(value))
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Only closed, locally chosen codes/statuses reach errors. Database/provider
// exceptions can contain credentials in request/query parameters, so their raw
// messages, bodies and causes must never enter the runner's log or state file.
export class SmokeGitHubSetupError extends Error {
  constructor(code, details = {}) {
    super(`issue1503_github_${code}`)
    this.name = 'SmokeGitHubSetupError'
    this.code = code
    this.details = details
  }
  toJSON() { return { code: this.code, details: this.details } }
}
const fail = (code, details) => { throw new SmokeGitHubSetupError(code, details) }
const safeError = (error, stage) => error instanceof SmokeGitHubSetupError ? error : new SmokeGitHubSetupError('dependency_failed', { stage })

function identity(value, stage) {
  if (!object(value) || String(value.id) !== GITHUB_ACCOUNT_ID || value.login !== GITHUB_LOGIN || value.type !== 'User') fail('identity_mismatch', { stage })
}

function validateState(state) {
  if (!object(state) || state.version !== 1 || state.issue !== 1503 || state.userId !== SMOKE_USER_ID || state.ownerUserId !== OWNER_USER_ID || state.githubAccountId !== GITHUB_ACCOUNT_ID ||
      state.githubLogin !== GITHUB_LOGIN || state.repository !== REPOSITORY || !/^[a-f0-9]{64}$/.test(state.tokenSha256 ?? '') ||
      !validId(state.appId) || !validId(state.repositoryId) || !validId(state.installationId) || !Number.isFinite(Date.parse(state.providerExpiresAt)) ||
      !Number.isFinite(Date.parse(state.connectionExpiresAt)) || !Number.isFinite(Date.parse(state.connectionUpdatedAt)) ||
      Date.parse(state.connectionExpiresAt) > Date.parse(state.providerExpiresAt)) fail('invalid_state')
}

/** Dependencies are injected only for unit tests; production calls below use
 * the application's existing credential, sealing and disconnection functions.
 * Returned state has public IDs, timestamps and a one-way random-token digest;
 * no access token, refresh token, client secret or sealed credential is exposed.
 */
export function createSmokeGitHubFixture({ application, appId, fetchImpl = fetch, now = Date.now, credentials }) {
  if (!application?.clientId || !application?.clientSecret || (appId && !validId(appId))) fail('app_not_configured')
  let resolvedAppId = appId ? String(appId) : null
  const basic = `Basic ${Buffer.from(`${application.clientId}:${application.clientSecret}`).toString('base64')}`

  async function request(path, { token, method = 'GET', body, stage, appAuth = false, expected = 200 } = {}) {
    let response
    try {
      response = await fetchImpl(API + path, {
        method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Mikka-Issue-1503-Authorized-Fixture',
          authorization: appAuth ? basic : `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch { fail('provider_transport', { stage }) }
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
    if (resolvedAppId) return
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
  }

  async function verifyRepository(token, stage) {
    const { data } = await request(`/repos/${REPOSITORY}`, { token, stage })
    if (!validId(data.id) || data.full_name !== REPOSITORY || data.permissions?.push !== true || data.archived !== false || data.disabled === true) fail('repository_unavailable', { stage })
    return String(data.id)
  }

  function verifyScopedAuthorization(data, stage, requireScope) {
    if (data.app?.client_id !== application.clientId) fail('scoped_app_mismatch')
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

  async function cleanup(state, inMemoryToken, progress = { revoked: false }) {
    validateState(state)
    let token = inMemoryToken, disconnected = false, revoked = progress.revoked
    const errors = []
    if (!token) {
      try { token = await credentials.readMatchingToken(state) }
      catch (error) { errors.push(safeError(error, 'read_cleanup_token').toJSON()) }
    }
    if (token && digest(token) !== state.tokenSha256) fail('cleanup_token_mismatch')
    if (token && !revoked) {
      try { await revoke(token); revoked = true; progress.revoked = true }
      catch (error) { errors.push(safeError(error, 'revoke_scoped_token').toJSON()) }
    } else if (!token && !revoked) errors.push({ code: 'cleanup_token_unavailable', details: {} })
    try { await credentials.disconnectMatching(state); disconnected = true }
    catch (error) { errors.push(safeError(error, 'disconnect_smoke').toJSON()) }
    if (errors.length) fail('cleanup_incomplete', { revoked, disconnected, errors })
    return { userId: SMOKE_USER_ID, revoked, disconnected }
  }

  async function setup({ ownerUserId, smokeUserId = SMOKE_USER_ID, repository = REPOSITORY } = {}) {
    if (smokeUserId !== SMOKE_USER_ID || repository !== REPOSITORY || ownerUserId !== OWNER_USER_ID) fail('fixture_target_mismatch')
    let mintedToken, state, stage = 'vacancy_check', sourceToken, saveAttempted = false
    try {
      await credentials.assertVacant()
      stage = 'owner_credential'
      const source = await credentials.githubTokenForUser(ownerUserId, { minValidityMs: OWNER_MIN_VALIDITY_MS })
      const sourceExpiry = source?.expiresAt == null ? null : new Date(source.expiresAt).getTime()
      if (!source?.token || source.githubAccountId !== GITHUB_ACCOUNT_ID || (sourceExpiry !== null && (!Number.isFinite(sourceExpiry) || sourceExpiry <= now() + OWNER_MIN_VALIDITY_MS))) fail('owner_credential_invalid')
      sourceToken = source.token
      identity((await request('/user', { token: sourceToken, stage: 'owner_identity' })).data, 'owner_identity')
      await verifyAndDiscoverApp(sourceToken)
      const repositoryId = await verifyRepository(sourceToken, 'owner_repository')
      const sourceRepository = await verifyRepositories(sourceToken, false, repositoryId)
      stage = 'mint_scoped_token'
      const minted = (await request(`/applications/${encodeURIComponent(application.clientId)}/token/scoped`, {
        method: 'POST', appAuth: true, stage,
        body: { access_token: sourceToken, target: GITHUB_LOGIN, repositories: [REPOSITORY.split('/')[1]], permissions: PERMISSIONS },
      })).data
      // Never consider the source token ours to revoke, even on a bad response.
      if (typeof minted.token !== 'string' || !minted.token || minted.token === sourceToken) fail('scoped_token_not_distinct')
      mintedToken = minted.token
      verifyScopedAuthorization(minted, 'scoped_response_identity', true)
      let providerExpiry = Date.parse(minted.expires_at)
      if (!Number.isFinite(providerExpiry) || providerExpiry <= now() + SCOPED_MIN_VALIDITY_MS) fail('scoped_expiry_invalid')
      identity((await request('/user', { token: mintedToken, stage: 'scoped_identity' })).data, 'scoped_identity')
      const confirmation = (await request(`/applications/${encodeURIComponent(application.clientId)}/token`, {
        method: 'POST', appAuth: true, body: { access_token: mintedToken }, stage: 'check_scoped_token',
      })).data
      if (typeof confirmation.token === 'string' && confirmation.token && confirmation.token !== mintedToken) fail('scoped_token_mismatch')
      const checkTokenScopeConfirmed = verifyScopedAuthorization(confirmation, 'check_scoped_token', false)
      if (confirmation.expires_at != null) {
        const checkedExpiry = Date.parse(confirmation.expires_at)
        if (!Number.isFinite(checkedExpiry) || checkedExpiry <= now() + SCOPED_MIN_VALIDITY_MS) fail('scoped_expiry_invalid')
        providerExpiry = Math.min(providerExpiry, checkedExpiry)
      }
      if (await verifyRepository(mintedToken, 'scoped_repository') !== repositoryId) fail('repository_mismatch', { stage: 'scoped_repository' })
      const scopedRepository = await verifyRepositories(mintedToken, true, repositoryId)
      if (scopedRepository.installationId !== sourceRepository.installationId) fail('repository_mismatch', { stage: 'scoped_installations' })
      // saveGitHubConnection captures its own Date.now(): leave a margin, then
      // verify the persisted timestamp in the same transaction before commit.
      const localExpiry = Math.min(providerExpiry, now() + LOCAL_MAX_VALIDITY_MS) - EXPIRY_MARGIN_MS
      const tokenSha256 = digest(mintedToken)
      stage = 'save_smoke_connection'
      saveAttempted = true
      const saved = await credentials.saveIfVacant({ token: mintedToken, expiresIn: Math.floor((localExpiry - now()) / 1000), providerExpiry, tokenSha256 })
      const candidate = { version: 1, issue: 1503, userId: SMOKE_USER_ID, ownerUserId, githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN,
        repository: REPOSITORY, appId: resolvedAppId, ...scopedRepository, checkTokenScopeConfirmed, providerExpiresAt: new Date(providerExpiry).toISOString(),
        connectionExpiresAt: saved.expiresAt, connectionUpdatedAt: saved.updatedAt, tokenSha256 }
      validateState(candidate)
      state = Object.freeze(candidate)
      let result
      const progress = { revoked: false }
      return {
        state,
        // Keep the newly minted token only in this closure. Repeated successful
        // cleanup calls are idempotent; a failed revocation remains retryable.
        cleanup: async () => { if (!result) result = await cleanup(state, mintedToken, progress); return result },
      }
    } catch (error) {
      const primary = safeError(error, stage)
      if (mintedToken) {
        try {
          if (state) await cleanup(state, mintedToken)
          else {
            const errors = []
            try { await revoke(mintedToken) } catch (error) { errors.push(safeError(error, 'revoke_scoped_token').toJSON()) }
            if (saveAttempted) {
              // Covers a commit that succeeded just before a transport failure.
              // The digest identifies only our new token, never a prior row.
              try { await credentials.discardIfNew(digest(mintedToken)) }
              catch (error) { errors.push(safeError(error, 'discard_new_connection').toJSON()) }
            }
            if (errors.length) fail('cleanup_incomplete', { errors })
          }
        } catch (cleanupError) {
          fail('setup_and_cleanup_failed', { primary: primary.toJSON(), cleanup: safeError(cleanupError, 'rollback').toJSON() })
        }
      }
      throw primary
    } finally { sourceToken = undefined }
  }

  return { setup, cleanup: state => cleanup(state) }
}

async function applicationDependencies() {
  // The normal server-only loader and tsx are required by the operator runner.
  // No credentials are loaded until the explicitly invoked setup/cleanup call.
  const [{ db, withDatabaseTransaction }, { githubConnections, users }, { eq, sql }, connection, { githubTokenForUser }] = await Promise.all([
    import('../../lib/db/index.ts'), import('../../lib/db/schema.ts'), import('drizzle-orm'),
    import('../../lib/github/connection.ts'), import('../../lib/github/user-access.ts'),
  ])

  async function assertVacant() {
    const user = await db.select({ id: users.id }).from(users).where(eq(users.id, SMOKE_USER_ID)).limit(1)
    if (user.length !== 1) fail('smoke_user_missing')
    if (await connection.githubConnection(SMOKE_USER_ID)) fail('smoke_connection_exists')
    const legacy = await db.execute(sql`SELECT 1 FROM account WHERE "userId" = ${SMOKE_USER_ID} AND "providerId" = 'github' LIMIT 1`)
    if (legacy.rows.length) fail('smoke_legacy_github_exists')
  }

  async function matchingRow(state, locked = false) {
    const query = db.select().from(githubConnections).where(eq(githubConnections.userId, SMOKE_USER_ID)).limit(1)
    const [row] = await (locked ? query.for('update') : query)
    if (!row) return null
    if (row.githubAccountId !== GITHUB_ACCOUNT_ID || row.githubLogin !== GITHUB_LOGIN || row.refreshToken != null || row.refreshTokenExpiresAt != null ||
        row.updatedAt.toISOString() !== state.connectionUpdatedAt || row.accessTokenExpiresAt?.toISOString() !== state.connectionExpiresAt) fail('smoke_connection_changed')
    const token = await connection.unsealGitHubSecret(row.accessToken)
    if (digest(token) !== state.tokenSha256) fail('smoke_connection_changed')
    return { token }
  }

  return {
    application: { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET },
    appId: process.env.GITHUB_APP_ID,
    credentials: {
      assertVacant, githubTokenForUser,
      saveIfVacant: input => db.transaction(tx => withDatabaseTransaction(tx, async () => {
        // Serializable isolation makes a concurrent insertion abort this
        // transaction rather than letting the existing upsert replace it.
        await assertVacant()
        if (!Number.isInteger(input.expiresIn) || input.expiresIn <= 0) fail('scoped_expiry_invalid')
        await connection.saveGitHubConnection(SMOKE_USER_ID, { githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN }, {
          access_token: input.token, expires_in: input.expiresIn,
          // Deliberately no refresh token or refresh expiry.
        })
        const [row] = await db.select().from(githubConnections).where(eq(githubConnections.userId, SMOKE_USER_ID)).limit(1)
        if (!row?.accessTokenExpiresAt || row.accessTokenExpiresAt.getTime() > input.providerExpiry || row.refreshToken != null || row.refreshTokenExpiresAt != null ||
            digest(await connection.unsealGitHubSecret(row.accessToken)) !== input.tokenSha256) fail('stored_credential_invalid')
        return { expiresAt: row.accessTokenExpiresAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
      }), { isolationLevel: 'serializable' }),
      readMatchingToken: async state => (await matchingRow(state))?.token ?? null,
      discardIfNew: tokenSha256 => db.transaction(tx => withDatabaseTransaction(tx, async () => {
        const [row] = await db.select().from(githubConnections).where(eq(githubConnections.userId, SMOKE_USER_ID)).for('update')
        if (row && row.githubAccountId === GITHUB_ACCOUNT_ID && row.githubLogin === GITHUB_LOGIN && row.refreshToken == null && row.refreshTokenExpiresAt == null &&
            digest(await connection.unsealGitHubSecret(row.accessToken)) === tokenSha256) await connection.disconnectGitHub(SMOKE_USER_ID)
      })),
      disconnectMatching: state => db.transaction(tx => withDatabaseTransaction(tx, async () => {
        if (await matchingRow(state, true)) await connection.disconnectGitHub(SMOKE_USER_ID)
      })),
    },
  }
}

/** Explicit operator entry point. Does not sign the smoke user in or create
 * sessions/workspaces/keys/profiles. Root acceptance uses normal product APIs. */
export async function setupIssue1503SmokeGitHub(options) {
  try { return await createSmokeGitHubFixture(await applicationDependencies()).setup(options) }
  catch (error) { throw safeError(error, 'application_setup') }
}

/** Recovery entry point accepts only safe state from this module. The exact
 * token digest and database timestamps must still match before any deletion. */
export async function cleanupIssue1503SmokeGitHub(state) {
  validateState(state)
  try { return await createSmokeGitHubFixture(await applicationDependencies()).cleanup(state) }
  catch (error) { throw safeError(error, 'application_cleanup') }
}
