import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

// Read-only inspection of one existing workload identity. No secrets API,
// provider credential export, mutation probe, identity creation or trust change.
export const TARGET = Object.freeze({
  repository: 'alexj11324/Mikka', repositoryId: 1427517699, ownerId: 183887963,
  ref: 'refs/heads/ops/infisical-cloud-capabilities',
  base: 'f59e2813242cbd98d615584dd4f4c96219dcc0ec',
  identity: '2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', audience: 'mikka-infisical',
  project: '89850d6a-f020-4936-863e-df77380dfe40',
  connection: 'mikka-team-vercel-native-sync',
  privateVercelProject: 'prj_vhbbfNIkhDO6grmZ3f6zMUH6k7rc',
})
// Same API origin as the existing pinned Infisical/secrets-action default.
const API = 'https://app.infisical.com'
const OWNED = ['.github/workflows/infisical-cloud-capabilities.yml',
  'scripts/ops/infisical-cloud-capabilities.mjs', 'scripts/ops/infisical-cloud-capabilities.test.mjs']
export const GET_ROUTES = Object.freeze({
  identity_details: '/api/v1/identities/details',
  project_membership: `/api/v1/projects/${TARGET.project}/memberships/identities/${TARGET.identity}`,
  project_permission_audit: `/api/v1/projects/${TARGET.project}/memberships/identities/${TARGET.identity}/permissions/audit?includeFolderPermissions=true`,
  known_connection: `/api/v1/app-connections/vercel/connection-name/${TARGET.connection}`,
  available_org_connections: '/api/v1/app-connections/vercel/available',
  project_vercel_syncs: `/api/v1/secret-syncs/vercel?projectId=${TARGET.project}`,
})
const CAPABILITIES = [
  ['app-connections', 'read-app-connections'], ['app-connections', 'connect-app-connections'],
  ['app-connections', 'create-app-connections'], ['app-connections', 'edit-app-connections'],
  ['secret-syncs', 'read'], ['secret-syncs', 'create'], ['secret-syncs', 'edit'], ['secret-syncs', 'sync-secrets'],
  ['secrets', 'create'], ['secrets', 'edit'],
]
class GuardError extends Error { constructor(code) { super(code); this.code = code } }
const requireThat = (value, code) => { if (!value) throw new GuardError(code) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const roleName = value => ['admin', 'member', 'viewer', 'no-access', 'custom'].includes(value) ? value : 'OTHER'

export function validateExecution({ env, event, head, parent, changed }) {
  requireThat(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REPOSITORY === TARGET.repository
    && env.GITHUB_REPOSITORY_ID === String(TARGET.repositoryId) && env.GITHUB_REPOSITORY_OWNER_ID === String(TARGET.ownerId)
    && env.GITHUB_REF === TARGET.ref && env.GITHUB_ACTOR === 'alexj11324' && env.GITHUB_RUN_ATTEMPT === '1', 'EXECUTION_SCOPE')
  requireThat(event?.repository?.id === TARGET.repositoryId && event.repository.full_name === TARGET.repository
    && event.repository.owner?.id === TARGET.ownerId && event.repository.fork === false
    && event.ref === TARGET.ref && event.after === head && env.GITHUB_SHA === head
    && !event.deleted && !event.forced && /^[a-f0-9]{40}$/.test(head), 'EVENT_SCOPE')
  requireThat(parent === TARGET.base && changed.length === OWNED.length
    && [...changed].sort().every((value, i) => value === [...OWNED].sort()[i]), 'SOURCE_SCOPE')
  return { checkout: head, base: parent, ref: TARGET.ref }
}

export function githubOidcUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new GuardError('OIDC_URL') }
  // The runner supplies an opaque request path; @actions/core does not require
  // an /idtoken suffix. Keep the reviewed GitHub host and transport boundary.
  requireThat(url.protocol === 'https:' && url.hostname.endsWith('.actions.githubusercontent.com')
    && url.port === '' && url.username === '' && url.password === '' && url.hash === '', 'OIDC_URL')
  url.searchParams.set('audience', TARGET.audience)
  return url.href
}

export function oidcUrlShape(value) {
  let url = null
  try { if (typeof value === 'string' && value.length > 0) url = new URL(value) } catch { /* No raw URL or error output. */ }
  const host = url?.hostname ?? ''
  const under = suffix => host === suffix || host.endsWith(`.${suffix}`)
  const pathClasses = ['idtoken', 'id-token', 'oidctoken', 'oidc-token', 'oidc', 'token']
  const path = url?.pathname ?? ''
  const pathClass = pathClasses.find(part => new RegExp(`/${part}/?$`, 'i').test(path)) ?? 'OTHER'
  return {
    present: typeof value === 'string' && value.length > 0,
    parseable: url !== null,
    scheme: url?.protocol === 'https:' ? 'https' : url?.protocol === 'http:' ? 'http' : 'OTHER',
    hostActionsGithubusercontent: under('actions.githubusercontent.com'),
    hostGithubusercontent: under('githubusercontent.com'),
    hostGithubCom: under('github.com'),
    hostGithubAppCom: under('githubapp.com'),
    hostAzureCom: under('azure.com'),
    hostVisualStudioCom: under('visualstudio.com'),
    hostLoopback: ['localhost', '127.0.0.1', '[::1]'].includes(host),
    pathClass,
    pathTrailingSlash: path.endsWith('/'),
    portPresent: url !== null && url.port !== '',
    userinfoPresent: url !== null && (url.username !== '' || url.password !== ''),
    fragmentPresent: url !== null && url.hash !== '',
  }
}

async function exchange(fetcher, operation, url, options, requests) {
  let response
  try { response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) }) }
  catch { requests.push({ operation, status: null, outcome: 'TRANSPORT' }); throw new GuardError('API_TRANSPORT') }
  const status = response.status
  requests.push({ operation, status })
  if (status !== 200) {
    await response.body?.cancel()
    return { status, outcome: ({ 400: 'bad_request', 401: 'unauthenticated', 403: 'denied', 404: 'not_found', 422: 'invalid_request' })[status] ?? 'http_error' }
  }
  requireThat(response.headers.get('content-type')?.includes('application/json'), 'API_CONTENT_TYPE')
  let data
  try { data = await response.json() } catch { throw new GuardError('API_JSON') }
  return { status, outcome: 'readable', data }
}

export async function login(env, requests, fetcher = fetch) {
  requireThat(typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'string' && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0, 'OIDC_ENV')
  const oidc = await exchange(fetcher, 'github_oidc', githubOidcUrl(env.ACTIONS_ID_TOKEN_REQUEST_URL), {
    method: 'GET', headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, accept: 'application/json' },
  }, requests)
  requireThat(oidc.status === 200 && typeof oidc.data?.value === 'string' && oidc.data.value.length > 0, 'OIDC_LOGIN')
  const reply = await exchange(fetcher, 'identity_oidc_login', `${API}/api/v1/auth/oidc-auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ identityId: TARGET.identity, jwt: oidc.data.value }),
  }, requests)
  requireThat(reply.status === 200 && reply.data?.tokenType === 'Bearer'
    && typeof reply.data.accessToken === 'string' && reply.data.accessToken.length > 0, 'IDENTITY_LOGIN')
  // Both temporary tokens stay in memory, never in env exports, files, summaries or logs.
  return reply.data.accessToken
}

export function metadataClient(accessToken, requests, fetcher = fetch) {
  requireThat(typeof accessToken === 'string' && accessToken.length > 0, 'TOKEN_MISSING')
  return operation => {
    requireThat(Object.hasOwn(GET_ROUTES, operation), 'API_ROUTE')
    return exchange(fetcher, operation, `${API}${GET_ROUTES[operation]}`, {
      method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    }, requests)
  }
}

export function permissionEvidence(payload) {
  requireThat(Array.isArray(payload?.sources) && payload.sources.length <= 200, 'AUDIT_SCHEMA')
  const rules = [], sourceRoles = [], counts = { role: 0, group_role: 0, additional_privilege: 0, OTHER: 0 }
  let unknownRuleCount = 0
  for (const source of payload.sources) {
    const kind = ['role', 'group_role', 'additional_privilege'].includes(source?.type) ? source.type : 'OTHER'
    counts[kind]++
    if (kind !== 'additional_privilege') sourceRoles.push(roleName(source?.slug))
    requireThat(Array.isArray(source?.permissions) && source.permissions.length <= 2000, 'AUDIT_SCHEMA')
    // Official CASL packRules format: action, subject, conditions, inverted, fields, reason.
    // This is rule-presence evidence, NOT a replacement for the provider's ability evaluator.
    for (const rule of source.permissions) {
      if (!Array.isArray(rule) || rule.length < 2 || rule.length > 6 || typeof rule[0] !== 'string' || typeof rule[1] !== 'string'
        || rule[0].length > 2048 || rule[1].length > 2048 || (rule[2] != null && rule[2] !== 0 && !object(rule[2]))
        || (rule[3] != null && ![0, 1].includes(rule[3])) || (rule[4] != null && rule[4] !== 0 && typeof rule[4] !== 'string')) {
        unknownRuleCount++; continue
      }
      rules.push({ actions: rule[0].split(','), subjects: rule[1].split(','), conditional: !!rule[2], inverted: !!rule[3], fields: !!rule[4] })
    }
  }
  const capabilities = CAPABILITIES.map(([subject, action]) => {
    const matching = rules.filter(rule => (rule.subjects.includes(subject) || rule.subjects.includes('all') || rule.subjects.includes('*'))
      && (rule.actions.includes(action) || rule.actions.includes('manage') || rule.actions.includes('*')))
    const grants = matching.filter(rule => !rule.inverted)
    return { subject, action, grantRules: grants.length, denyRules: matching.length - grants.length,
      conditionalGrantRules: grants.filter(rule => rule.conditional).length, fieldRestrictedGrantRules: grants.filter(rule => rule.fields).length,
      grantAbsent: unknownRuleCount === 0 && grants.length === 0 }
  })
  return { evidence: 'active_rule_presence_only', sourceCount: payload.sources.length, sourceKinds: counts,
    sourceRoles, unknownRuleCount, capabilities }
}

export function projectMetadata(operation, data, context) {
  if (operation === 'identity_details') {
    const org = data?.identityDetails?.organization
    requireThat(uuid(org?.id), 'IDENTITY_DETAILS_SCHEMA')
    context.orgId = org.id
    return { organizationIdValid: true, knownOrganizationNameMatches: org.name === 'Aspectly Labs' }
  }
  if (operation === 'project_membership') {
    const membership = data?.identityMembership
    requireThat(membership?.identity?.id === TARGET.identity && Array.isArray(membership.roles) && membership.roles.length <= 100, 'MEMBERSHIP_SCHEMA')
    return { identityMatches: true, organizationMatches: context.orgId ? membership.identity.orgId === context.orgId : null,
      roles: membership.roles.map(row => ({ role: roleName(row.role), temporary: row.isTemporary === true })) }
  }
  if (operation === 'project_permission_audit') return permissionEvidence(data)
  if (operation === 'known_connection') {
    const connection = data?.appConnection
    requireThat(connection?.name === TARGET.connection && connection.app === 'vercel' && connection.method === 'api-token'
      && uuid(connection.id) && connection.projectId == null, 'CONNECTION_SCOPE')
    requireThat(object(connection.credentials) && Object.keys(connection.credentials).length === 0, 'CONNECTION_NOT_SANITIZED')
    context.connectionId = connection.id
    return { knownNameMatches: true, connectionId: connection.id, organizationScoped: true,
      organizationMatches: context.orgId ? connection.orgId === context.orgId : null, credentialsEmpty: true }
  }
  if (operation === 'available_org_connections') {
    requireThat(Array.isArray(data?.appConnections) && data.appConnections.length <= 200, 'AVAILABLE_SCHEMA')
    const matches = data.appConnections.filter(row => row?.name === TARGET.connection && row.app === 'vercel' && row.projectId == null)
    requireThat(matches.length <= 1 && matches.every(row => uuid(row.id) && !Object.hasOwn(row, 'credentials')
      && (!context.orgId || row.orgId === context.orgId)), 'AVAILABLE_SCOPE')
    return { targetAvailableForConnect: matches.length === 1, returnedCount: data.appConnections.length,
      connectionIdMatches: matches.length === 1 && context.connectionId ? matches[0].id === context.connectionId : null }
  }
  if (operation === 'project_vercel_syncs') {
    requireThat(Array.isArray(data?.secretSyncs) && data.secretSyncs.length <= 200
      && data.secretSyncs.every(row => row?.projectId === TARGET.project && row.destination === 'vercel'), 'SYNC_SCOPE')
    const matched = data.secretSyncs.filter(row => row.connection?.name === TARGET.connection)
    const privateSyncs = matched.filter(row => row.destinationConfig?.scope === 'project' && row.destinationConfig.app === TARGET.privateVercelProject)
    return { totalCount: data.secretSyncs.length, knownConnectionSyncCount: matched.length,
      privateProjectSyncCount: privateSyncs.length,
      privateProductionSyncCount: privateSyncs.filter(row => row.destinationConfig?.env === 'production').length,
      teamScopeSyncCount: matched.filter(row => row.destinationConfig?.scope === 'team').length,
      unknownScopeSyncCount: matched.filter(row => !['project', 'team'].includes(row.destinationConfig?.scope)).length }
  }
  throw new GuardError('API_ROUTE')
}

export async function inspect(request) {
  const context = {}, results = {}
  for (const operation of Object.keys(GET_ROUTES)) {
    try {
      const reply = await request(operation)
      results[operation] = { status: reply.status, outcome: reply.outcome }
      if (reply.status === 200) results[operation].metadata = projectMetadata(operation, reply.data, context)
    } catch (error) {
      results[operation] = { outcome: 'blocked', error: error instanceof GuardError ? error.code : 'INSPECTION_FAILED' }
    }
  }
  return results
}

async function main() {
  const report = { identity: TARGET.identity, project: TARGET.project, connection: TARGET.connection,
    result: 'blocked', requests: [], applicationSecretsRequested: false, providerCredentialsRequested: false,
    configurationWrites: 0, identityOrTrustChanges: false }
  try {
    requireThat(process.argv.length === 3 && ['--preflight', '--url-shape', '--inspect'].includes(process.argv[2]), 'MODE')
    report.execution = validateExecution({ env: process.env, event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')),
      head: git('rev-parse', 'HEAD'), parent: git('rev-parse', 'HEAD^'), changed: git('diff', '--name-only', 'HEAD^', 'HEAD').split('\n').filter(Boolean) })
    if (process.argv[2] === '--preflight') report.result = 'source_verified'
    else if (process.argv[2] === '--url-shape') {
      report.urlShape = oidcUrlShape(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
      report.result = 'url_shape_inspected'
    } else {
      const accessToken = await login(process.env, report.requests)
      report.results = await inspect(metadataClient(accessToken, report.requests))
      report.result = 'inspected'
    }
  } catch (error) { report.error = error instanceof GuardError ? error.code : 'INSPECTION_FAILED'; process.exitCode = 1 }
  const safe = JSON.stringify(report)
  console.log(safe)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Existing Infisical identity capability inspection\n\n\`\`\`json\n${safe}\n\`\`\`\n`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
