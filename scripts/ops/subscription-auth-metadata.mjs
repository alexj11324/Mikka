import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const BRANCH = 'diagnostics/1217-subscription-auth-20261104'
const REPOSITORY = 'alexj11324/Mikka'
const OWNER_ID = '183887963', REPOSITORY_ID = '1427517699'
const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH', TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
const IDENTITY = '2cf9fa19-b9db-4c08-8ca0-b31859f2cbac'
const INFISICAL_PROJECT = '89850d6a-f020-4936-863e-df77380dfe40'
const INFISICAL = 'https://app.infisical.com'
const fail = code => { throw new Error(code) }
const relevantKey = key => typeof key === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(key)
  && (/^MIKKA_BYOS_|^INFISICAL_/.test(key) || ['BETTER_AUTH_OAUTH_PROXY_URL', 'BETTER_AUTH_OAUTH_PROXY_SECRET', 'BETTER_AUTH_URL'].includes(key))

export function assertWorkflow(env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REPOSITORY_ID !== REPOSITORY_ID
    || env.GITHUB_REPOSITORY_OWNER_ID !== OWNER_ID || env.GITHUB_REF !== 'refs/heads/' + BRANCH
    || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_RUN_ATTEMPT !== '1'
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) fail('diagnostic_workflow_refused')
}

export function assertClaims(claims, env) {
  const ref = 'refs/heads/' + BRANCH
  const subject = `repo:alexj11324@${OWNER_ID}/Mikka@${REPOSITORY_ID}:ref:${ref}`
  if (claims.iss !== 'https://token.actions.githubusercontent.com' || claims.aud !== 'mikka-infisical'
    || claims.sub !== subject || claims.repository !== REPOSITORY || claims.repository_id !== REPOSITORY_ID
    || claims.repository_owner_id !== OWNER_ID || claims.ref !== ref || claims.sha !== env.GITHUB_SHA
    || claims.event_name !== 'push'
    || claims.workflow_ref !== `${REPOSITORY}/.github/workflows/subscription-auth-metadata.yml@${ref}`) fail('diagnostic_oidc_claims_refused')
}

/** Project values, ciphertext, comments and identities' credentials are deliberately discarded. */
export function metadataOnly(data) {
  if (!Array.isArray(data?.envs)) fail('diagnostic_env_shape')
  const rows = data.envs.filter(row => relevantKey(row.key)).map(row => {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(row.id ?? '') || !Array.isArray(row.target)
      || row.target.some(target => !['production', 'preview', 'development'].includes(target))) fail('diagnostic_env_metadata_invalid')
    return { key: row.key, id: row.id, target: [...row.target].sort() }
  })
  return rows.sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id))
}

async function json(fetchImpl, url, stage, options = {}) {
  let response
  try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20_000) }) }
  catch { fail(stage + '_transport') }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); fail(stage + '_http_' + response.status) }
  try {
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > 2_000_000) fail(stage + '_oversized')
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch { fail(stage + '_invalid_json') }
}

async function configuration({ env, fetchImpl }) {
  assertWorkflow(env)
  const requestUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL)
  if (requestUrl.protocol !== 'https:' || !requestUrl.hostname.endsWith('.actions.githubusercontent.com')
    || requestUrl.username || requestUrl.password || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) fail('diagnostic_oidc_endpoint_refused')
  requestUrl.searchParams.set('audience', 'mikka-infisical')
  const oidc = await json(fetchImpl, requestUrl, 'github_oidc', { headers: { authorization: 'Bearer ' + env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } })
  if (typeof oidc.value !== 'string') fail('diagnostic_oidc_missing')
  let claims
  try { claims = JSON.parse(Buffer.from(oidc.value.split('.')[1], 'base64url').toString('utf8')) }
  catch { fail('diagnostic_oidc_invalid') }
  assertClaims(claims, env)
  // The existing identity verifies the signature and its configured trust. The local claims check cannot grant authority.
  const login = await json(fetchImpl, INFISICAL + '/api/v1/auth/oidc-auth/login', 'infisical_oidc', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identityId: IDENTITY, jwt: oidc.value }),
  })
  if (typeof login.accessToken !== 'string' || !login.accessToken) fail('diagnostic_infisical_token_missing')
  const secretUrl = new URL('/api/v4/secrets/VERCEL_DEPLOY_TOKEN', INFISICAL)
  for (const [key, value] of Object.entries({ projectId: INFISICAL_PROJECT, environment: 'prod', secretPath: '/platform', type: 'shared', includeImports: 'false' })) secretUrl.searchParams.set(key, value)
  const secret = await json(fetchImpl, secretUrl, 'existing_vercel_token', { headers: { authorization: 'Bearer ' + login.accessToken } })
  const token = secret?.secret?.secretValue
  if (secret?.secret?.secretKey !== 'VERCEL_DEPLOY_TOKEN' || typeof token !== 'string' || !token) fail('diagnostic_vercel_token_missing')
  const vercel = async path => {
    const url = new URL(path, 'https://api.vercel.com'); url.searchParams.set('teamId', TEAM)
    return json(fetchImpl, url, path.includes('/env') ? 'vercel_env_metadata' : 'vercel_project_metadata', { headers: { authorization: 'Bearer ' + token } })
  }
  const project = await vercel('/v9/projects/' + PROJECT)
  if (project.id !== PROJECT || project.accountId !== TEAM || project.link?.type !== 'github'
    || String(project.link.repoId) !== REPOSITORY_ID) fail('diagnostic_project_mismatch')
  const data = await vercel('/v10/projects/' + PROJECT + '/env?decrypt=false')
  return { data, vercel }
}

export async function diagnose({ env = process.env, fetchImpl = fetch } = {}) {
  const { data } = await configuration({ env, fetchImpl })
  const entries = metadataOnly(data)
  return { schema: 1, status: 'read', source: env.GITHUB_SHA, branch: BRANCH, at: new Date().toISOString(),
    identity: IDENTITY, oidcClaimsVerified: true, project: PROJECT, team: TEAM,
    metadataOnly: true, decryptedValuesRequested: false, receivedEnvCount: data.envs.length, relevantEnvCount: entries.length, entries }
}

// These are the only configuration values approved for this second diagnostic.
// IDs come from the immutable, metadata-only result of run 41905528503.
const PREFIX = 'MIKKA_BYOS_'
export const CONFIG_IDS = {
  production: {
    INFISICAL_ORIGIN: 'D526yqhIQZgAwN7b', INFISICAL_PROJECT: 'dQ5ZRWQRJrd42h4V',
    INFISICAL_ENVIRONMENT: 'SmU45AHpfIYCORz6', INFISICAL_PATH: 'DqFCq5IF4D8rofes',
    ACCESS_INFISICAL_PROJECT: '8x16zndBNZyBfI5C', ACCESS_INFISICAL_PATH: 'ME1mSZ9oSoSIvyvH',
    SHARED_CUSTODY_IDENTITY: '5hr4fSqZ1RC8EzAO', CUSTODY_CLIENT_ID: 'hodTmm0vZAjgFXQg',
    CUSTODY_CLIENT_SECRET: 'r24YnEs6TLnjiZ9Y', ACCESS_CLIENT_ID: 'u6tShExO0npVrFYU',
    ACCESS_CLIENT_SECRET: 'w7Kx44PtmPdtepuG',
  },
  preview: {
    INFISICAL_ORIGIN: 'vIf7PPABuDTRqPcL', INFISICAL_PROJECT: 'KQ28KjaOnHkPQOZJ',
    INFISICAL_ENVIRONMENT: 'CU1vVvyAJVf64jAE', INFISICAL_PATH: 'wvRmef1fG8ORdv8b',
    ACCESS_INFISICAL_PROJECT: 'GDTKhmoUDLd9hKr8', ACCESS_INFISICAL_PATH: '42ZuNleMMClEiuO5',
    SHARED_CUSTODY_IDENTITY: '6ZYtAAqBOlkJKxfq', CUSTODY_CLIENT_ID: 'QMsD7K7tDOTjYfUY',
    CUSTODY_CLIENT_SECRET: '5NyfuSXvCFA75AFz',
  },
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const ORIGINS = new Set(['https://app.infisical.com', 'https://us.infisical.com', 'https://eu.infisical.com'])
const safeCode = error => /^(diagnostic|github_oidc|infisical_oidc|existing_vercel_token|vercel_env_metadata|vercel_project_metadata|runtime)_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'diagnostic_failed'
const isDefault = row => !row.gitBranch && (!row.customEnvironmentIds || row.customEnvironmentIds.length === 0)
const bearer = token => ({ headers: { authorization: 'Bearer ' + token } })
const validPath = path => typeof path === 'string' && /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(path) && path.length <= 256

export function runtimeRows(data, target) {
  if (!Array.isArray(data?.envs) || !CONFIG_IDS[target]) fail('runtime_env_shape')
  const selected = new Map()
  for (const suffix of Object.keys(CONFIG_IDS.production)) {
    const rows = data.envs.filter(row => row.key === PREFIX + suffix && Array.isArray(row.target) && row.target.includes(target) && isDefault(row))
    if (rows.length > 1) fail('runtime_default_config_ambiguous')
    if (rows.length === 1) {
      if (rows[0].id !== CONFIG_IDS[target][suffix]) fail('runtime_config_identity_changed')
      selected.set(suffix, rows[0])
    }
  }
  return selected
}

export function permissionMetadata(data, project, slug) {
  const role = data?.role
  if (role?.projectId !== project || role.slug !== slug || !Array.isArray(role.permissions) || role.permissions.length > 200) fail('runtime_role_shape')
  return role.permissions.map(rule => {
    const actions = Array.isArray(rule.action) ? rule.action : [rule.action]
    const subjects = Array.isArray(rule.subject) ? rule.subject : [rule.subject]
    if (actions.length > 30 || subjects.length > 30 || [...actions, ...subjects].some(value => typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9:_-]{0,127}$/.test(value))) fail('runtime_permission_shape')
    const conditions = rule.conditions
    const scoped = {}
    for (const key of ['environment', 'secretPath']) {
      if (conditions?.[key] === undefined) continue
      const value = conditions[key]
      const safeValue = item => typeof item === 'string' && item.length <= 256 && /^[A-Za-z0-9_/*?.-]+$/.test(item)
      if (safeValue(value)) scoped[key] = value
      else if (value && typeof value === 'object' && !Array.isArray(value)
        && Object.entries(value).every(([op, operand]) => ['$eq', '$ne', '$in', '$nin', '$glob'].includes(op)
          && (Array.isArray(operand) ? operand.length <= 30 && operand.every(safeValue) : safeValue(operand)))) scoped[key] = value
      else scoped[key] = { unreadableCondition: true }
    }
    return { actions, subjects, inverted: rule.inverted === true, scoped,
      otherConditionsPresent: conditions !== undefined && (conditions === null || typeof conditions !== 'object'
        || Array.isArray(conditions) || Object.keys(conditions).some(key => !['environment', 'secretPath'].includes(key))) }
  })
}

async function inspectMembership({ fetchImpl, origin, token, identityId, project }) {
  const result = { project, status: 'blocked', roles: [], effectivePermissionDecision: 'not_evaluated' }
  try {
    const data = await json(fetchImpl, `${origin}/api/v1/projects/${project}/memberships/identities/${identityId}`, 'runtime_membership', bearer(token))
    const membership = data?.identityMembership
    if (membership?.identity?.id !== identityId
      || (membership.identity.projectId != null && membership.identity.projectId !== project)
      || (membership.projectId != null && membership.projectId !== project)
      || (membership.project != null && membership.project.id !== project)
      || !Array.isArray(membership.roles) || membership.roles.length > 20) fail('runtime_membership_shape')
    result.status = 'read'; result.httpStatus = 200
    const roleCache = new Map()
    for (const entry of membership.roles) {
      if (!SLUG.test(entry.role ?? '')) fail('runtime_membership_role_shape')
      const role = { role: entry.role, temporary: entry.isTemporary === true }
      for (const key of ['temporaryAccessStartTime', 'temporaryAccessEndTime']) {
        if (entry[key] != null) {
          if (typeof entry[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?$/.test(entry[key])) fail('runtime_membership_expiry_shape')
          role[key] = entry[key]
        }
      }
      if (entry.customRoleSlug) {
        if (!SLUG.test(entry.customRoleSlug)) fail('runtime_custom_role_shape')
        role.customRoleSlug = entry.customRoleSlug
        if (!roleCache.has(entry.customRoleSlug)) {
          try {
            const data = await json(fetchImpl, `${origin}/api/v1/projects/${project}/roles/slug/${entry.customRoleSlug}`, 'runtime_role', bearer(token))
            roleCache.set(entry.customRoleSlug, { status: 'read', httpStatus: 200, permissions: permissionMetadata(data, project, entry.customRoleSlug) })
          } catch (error) { roleCache.set(entry.customRoleSlug, { status: 'blocked', code: safeCode(error) }) }
        }
        role.permissionMetadata = roleCache.get(entry.customRoleSlug)
      } else role.permissionMetadata = { status: 'not_requested', reason: 'built_in_role_not_inferred' }
      result.roles.push(role)
    }
  } catch (error) { result.status = 'blocked'; result.code = safeCode(error) }
  return result
}

export async function diagnoseRuntime({ env = process.env, fetchImpl = fetch } = {}) {
  const { data, vercel } = await configuration({ env, fetchImpl })
  const report = { schema: 2, status: 'read', source: env.GITHUB_SHA, branch: BRANCH, at: new Date().toISOString(),
    project: PROJECT, team: TEAM, receivedEnvCount: data.envs.length, configurationScope: 'current_project_default_targets',
    deployedConfigurationVerified: false, featureFlagStateVerified: false, providerOAuthStarted: false,
    byosSecretRecordsRead: false, mutationsOtherThanAuthentication: false, targets: [], identities: [] }
  const sessions = []
  for (const target of ['production', 'preview']) {
    const result = { target, status: 'blocked', mode: 'unresolved', configurationReads: [], identities: [] }
    report.targets.push(result)
    try {
      const selected = runtimeRows(data, target), config = {}
      const read = async suffix => {
        const row = selected.get(suffix)
        if (!row) return undefined
        const attempt = { key: row.key, id: row.id, status: 'blocked' }
        result.configurationReads.push(attempt)
        const loaded = await vercel(`/v1/projects/${PROJECT}/env/${row.id}`)
        if (loaded.id !== row.id || loaded.key !== PREFIX + suffix || !Array.isArray(loaded.target) || !loaded.target.includes(target) || !isDefault(loaded)
          || typeof loaded.value !== 'string' || loaded.value.length > 16_384) fail('runtime_config_value_unavailable')
        if (row.updatedAt !== loaded.updatedAt) fail('runtime_config_changed_during_read')
        attempt.status = 'read'
        config[suffix] = loaded.value
        return loaded.value
      }
      for (const suffix of ['INFISICAL_ORIGIN', 'INFISICAL_PROJECT', 'INFISICAL_ENVIRONMENT', 'INFISICAL_PATH',
        'ACCESS_INFISICAL_PROJECT', 'ACCESS_INFISICAL_PATH', 'SHARED_CUSTODY_IDENTITY']) await read(suffix)
      const origin = config.INFISICAL_ORIGIN
      if (!ORIGINS.has(origin)) fail('runtime_origin_not_approved')
      const project = config.INFISICAL_PROJECT, accessProject = config.ACCESS_INFISICAL_PROJECT ?? project
      if (!UUID.test(project ?? '') || !UUID.test(accessProject ?? '') || !SLUG.test(config.INFISICAL_ENVIRONMENT ?? '')
        || !validPath(config.INFISICAL_PATH) || !validPath(config.ACCESS_INFISICAL_PATH)
        || config.INFISICAL_PATH === config.ACCESS_INFISICAL_PATH) fail('runtime_scope_invalid')
      result.scope = { origin, project, accessProject, environment: config.INFISICAL_ENVIRONMENT,
        custodyPath: config.INFISICAL_PATH, accessPath: config.ACCESS_INFISICAL_PATH }
      const shared = config.SHARED_CUSTODY_IDENTITY === '1'
      if (!shared && data.envs.some(row => ['MIKKA_BYOS_INFISICAL_TOKEN', 'MIKKA_BYOS_ACCESS_INFISICAL_TOKEN'].includes(row.key)
        && row.target?.includes(target) && isDefault(row))) fail('runtime_static_mode_outside_diagnostic')
      for (const suffix of ['CUSTODY_CLIENT_ID', 'CUSTODY_CLIENT_SECRET', ...(!shared ? ['ACCESS_CLIENT_ID', 'ACCESS_CLIENT_SECRET'] : [])]) await read(suffix)
      if (!config.CUSTODY_CLIENT_ID || !config.CUSTODY_CLIENT_SECRET
        || (!shared && (!config.ACCESS_CLIENT_ID || !config.ACCESS_CLIENT_SECRET || config.ACCESS_CLIENT_ID === config.CUSTODY_CLIENT_ID))) fail('runtime_identity_configuration_incomplete')
      result.mode = shared ? 'shared_custody_authorized_access_snapshot' : 'separate_custody_and_access_workload'
      for (const use of shared ? ['custody_and_authorized_access'] : ['custody', 'access']) {
        const clientId = use === 'access' ? config.ACCESS_CLIENT_ID : config.CUSTODY_CLIENT_ID
        const clientSecret = use === 'access' ? config.ACCESS_CLIENT_SECRET : config.CUSTODY_CLIENT_SECRET
        let session = sessions.find(item => item.origin === origin && item.clientId === clientId)
        if (session && session.clientSecret !== clientSecret) fail('runtime_same_client_different_configured_secret')
        if (!session) {
          if (sessions.length >= 3) fail('runtime_login_bound_exceeded')
          session = { origin, clientId, clientSecret, memberships: new Map(), report: { index: sessions.length, status: 'blocked', loginAttempts: 1, memberships: [] } }
          sessions.push(session); report.identities.push(session.report)
          try {
            const login = await json(fetchImpl, origin + '/api/v1/auth/universal-auth/login', 'runtime_login', {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret }),
            })
            if (typeof login.accessToken !== 'string' || !login.accessToken) fail('runtime_access_token_missing')
            session.token = login.accessToken
            session.report.loginHttpStatus = 200
            let claims
            try { claims = JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString('utf8')) }
            catch { fail('runtime_token_locator_invalid') }
            if (!UUID.test(claims.identityId ?? '')) fail('runtime_token_locator_invalid')
            // A locator, not a local authorization decision. Every metadata GET is server-authorized.
            session.identityId = claims.identityId
            const details = await json(fetchImpl, origin + '/api/v1/identities/details', 'runtime_identity_details', bearer(session.token))
            if (!UUID.test(details?.identityDetails?.organization?.id ?? '')) fail('runtime_identity_details_shape')
            session.report.identityId = claims.identityId
            session.report.organizationId = details.identityDetails.organization.id
            session.report.status = 'authenticated'; session.report.identityDetailsHttpStatus = 200
          } catch (error) { session.report.code = safeCode(error) }
        }
        result.identities.push({ use, index: session.report.index })
        if (session.report.status !== 'authenticated') fail('runtime_selected_identity_unavailable')
        const projects = use === 'custody_and_authorized_access' || use === 'custody' ? [project, accessProject] : [accessProject]
        for (const membershipProject of new Set(projects)) {
          if (!session.memberships.has(membershipProject)) {
            const membership = await inspectMembership({ fetchImpl, origin, token: session.token, identityId: session.identityId, project: membershipProject })
            session.memberships.set(membershipProject, membership); session.report.memberships.push(membership)
          }
        }
      }
      result.status = 'authenticated_config'; result.newIsolatedConnectionReadiness = 'not_established'
      result.permissionMetadataStatus = result.identities.every(reference => report.identities[reference.index].memberships
        .every(membership => membership.status === 'read' && membership.roles.every(role => role.permissionMetadata.status !== 'blocked'))) ? 'read' : 'partial'
      if (result.permissionMetadataStatus === 'partial') report.status = 'partial'
    } catch (error) { result.code = safeCode(error); report.status = 'partial' }
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report
  try { report = await (process.argv.includes('--runtime') ? diagnoseRuntime() : diagnose()); if (report.status === 'partial') process.exitCode = 1 }
  catch (error) {
    const code = safeCode(error)
    report = { schema: process.argv.includes('--runtime') ? 2 : 1, status: 'blocked', code, at: new Date().toISOString() }; process.exitCode = 1
  }
  // Only this constructed allowlist report reaches disk or output. No raw responses or exception stacks.
  await writeFile('subscription-auth-metadata.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
