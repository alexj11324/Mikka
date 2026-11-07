import { execFileSync } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

// Read-only source-scope proof for one proposed folder. No secrets API,
// folder/key creation, provider credential export, sync mutation or trust change.
export const TARGET = Object.freeze({
  repository: 'alexj11324/Mikka', repositoryId: 1427517699, ownerId: 183887963,
  ref: 'refs/heads/ops/infisical-cloud-source-scope',
  base: 'a1902d720c5cd6b3ff45d94cfe1bc154d4aa38b9',
  identity: '2cf9fa19-b9db-4c08-8ca0-b31859f2cbac', audience: 'mikka-infisical',
  project: '89850d6a-f020-4936-863e-df77380dfe40',
  connection: 'mikka-team-vercel-native-sync',
  environment: 'prod', path: '/mikka-cloud-production',
  publicVercelProject: 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH',
  privateVercelProject: 'prj_vhbbfNIkhDO6grmZ3f6zMUH6k7rc',
})
// Same API origin as the existing pinned Infisical/secrets-action default.
const API = 'https://app.infisical.com'
const OWNED = ['.github/workflows/infisical-cloud-source-scope.yml',
  'scripts/ops/infisical-cloud-source-scope.mjs', 'scripts/ops/infisical-cloud-source-scope.test.mjs']
class GuardError extends Error { constructor(code) { super(code); this.code = code } }
const requireThat = (value, code) => { if (!value) throw new GuardError(code) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

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

export const LIMITS = Object.freeze({ syncs: 16, nodes: 64, edges: 128, requests: 80 })
const ENVIRONMENTS = ['prod', 'staging', 'dev']
const validPath = value => typeof value === 'string' && value.length <= 512
  && (value === '/' || /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(value))
const scopeKey = scope => scope.environment + ':' + scope.path
const targetScope = scope => scope.environment === TARGET.environment && scope.path === TARGET.path
const contains = (parent, child) => parent === '/' || child === parent || child.startsWith(parent + '/')

function validateScope(scope) {
  requireThat(object(scope) && ENVIRONMENTS.includes(scope.environment) && validPath(scope.path), 'METADATA_SCOPE')
}

export function metadataRoute(operation, scope) {
  if (operation === 'project_permissions') return '/api/v1/projects/' + TARGET.project
    + '/memberships/identities/' + TARGET.identity + '/permissions/audit?includeFolderPermissions=true'
  if (operation === 'project_vercel_syncs') return '/api/v1/secret-syncs/vercel?projectId=' + TARGET.project
  requireThat(operation === 'imports' || operation === 'subfolders', 'API_ROUTE')
  validateScope(scope)
  const query = new URLSearchParams({ projectId: TARGET.project, environment: scope.environment, path: scope.path })
  if (operation === 'subfolders') query.set('recursive', 'true')
  return (operation === 'imports' ? '/api/v2/secret-imports?' : '/api/v2/folders?') + query
}

export function metadataClient(accessToken, requests, fetcher = fetch) {
  requireThat(typeof accessToken === 'string' && accessToken.length > 0, 'TOKEN_MISSING')
  let count = 0
  return (operation, scope) => {
    const path = metadataRoute(operation, scope)
    requireThat(++count <= LIMITS.requests, 'REQUEST_LIMIT')
    return exchange(fetcher, operation, API + path, {
      method: 'GET', headers: { authorization: 'Bearer ' + accessToken, accept: 'application/json' },
    }, requests)
  }
}

// The list endpoint filters by project permission. Prove unrestricted read rules
// before treating an empty or partial returned list as complete scope evidence.
export function validateReadPermissions(data) {
  requireThat(Array.isArray(data?.sources) && data.sources.length > 0 && data.sources.length <= 200, 'AUDIT_SCHEMA')
  const rules = []
  for (const source of data.sources) {
    requireThat(Array.isArray(source?.permissions) && source.permissions.length <= 2000, 'AUDIT_SCHEMA')
    for (const row of source.permissions) {
      requireThat(Array.isArray(row) && row.length >= 2 && row.length <= 6
        && typeof row[0] === 'string' && row[0].length <= 2048 && typeof row[1] === 'string' && row[1].length <= 2048
        && (row[2] == null || row[2] === 0 || object(row[2]))
        && (row[3] == null || [0, 1].includes(row[3]))
        && (row[4] == null || row[4] === 0 || typeof row[4] === 'string'), 'AUDIT_SCHEMA')
      rules.push({ actions: row[0].split(','), subjects: row[1].split(','), conditional: !!row[2], deny: !!row[3], fields: !!row[4] })
    }
  }
  for (const subject of ['secret-syncs', 'secret-imports']) {
    const matching = rules.filter(row => (row.subjects.includes(subject) || row.subjects.includes('all') || row.subjects.includes('*'))
      && (row.actions.includes('read') || row.actions.includes('manage') || row.actions.includes('*')))
    requireThat(matching.some(row => !row.conditional && !row.deny && !row.fields)
      && !matching.some(row => row.deny), 'PROJECT_READ_NOT_UNRESTRICTED')
  }
  return { syncReadUnrestricted: true, importReadUnrestricted: true }
}

export function projectSyncs(data) {
  requireThat(Array.isArray(data?.secretSyncs) && data.secretSyncs.length <= LIMITS.syncs, 'SYNC_LIST_SCHEMA')
  const ids = new Set()
  return data.secretSyncs.map(row => {
    requireThat(row?.projectId === TARGET.project && row.destination === 'vercel' && uuid(row.id) && !ids.has(row.id), 'SYNC_SCOPE')
    ids.add(row.id)
    requireThat(row.connection?.app === 'vercel' && row.connection.name === TARGET.connection && uuid(row.connection.id)
      && !Object.hasOwn(row.connection, 'credentials') && !Object.hasOwn(row.connection, 'encryptedCredentials'), 'CONNECTION_SCOPE')
    requireThat(row.destinationConfig?.scope === 'project'
      && [TARGET.publicVercelProject, TARGET.privateVercelProject].includes(row.destinationConfig.app)
      && ['production', 'preview', 'development'].includes(row.destinationConfig.env), 'DESTINATION_SCOPE')
    requireThat(uuid(row.environment?.id) && uuid(row.folder?.id), 'SYNC_SOURCE_UNRESOLVED')
    const source = { environment: row.environment.slug, path: row.folder.path }
    validateScope(source)
    requireThat(object(row.syncOptions) && [undefined, null, true, false].includes(row.syncOptions.includeAllSubFolders)
      && typeof row.isAutoSyncEnabled === 'boolean', 'SYNC_OPTIONS_SCHEMA')
    const includeAllSubFolders = Boolean(row.syncOptions.includeAllSubFolders)
    return { id: row.id, connectionId: row.connection.id,
      destination: row.destinationConfig.app === TARGET.publicVercelProject ? 'public_project' : 'private_project',
      destinationEnvironment: row.destinationConfig.env, branchPresent: !!row.destinationConfig.branch,
      environment: source.environment, environmentId: row.environment.id, path: source.path, folderId: row.folder.id,
      autoSyncEnabled: row.isAutoSyncEnabled, includeAllSubFolders, effectiveIncludeImports: true,
      directCoverage: source.environment === TARGET.environment
        && (source.path === TARGET.path || (includeAllSubFolders && contains(source.path, TARGET.path))) }
  })
}

export function projectImports(data, scope) {
  requireThat(Array.isArray(data?.secretImports) && data.secretImports.length <= LIMITS.edges, 'IMPORT_LIST_SCHEMA')
  let folderId = scope.folderId
  return data.secretImports.map(row => {
    requireThat(uuid(row?.id) && uuid(row.folderId) && uuid(row.importEnv?.id), 'IMPORT_SCHEMA')
    if (!folderId) folderId = row.folderId
    requireThat(row.folderId === folderId, 'IMPORT_FOLDER_SCOPE')
    requireThat(row.importEnv.projectId === TARGET.project, 'IMPORT_PROJECT_UNRESOLVED')
    requireThat([undefined, null, false].includes(row.isReplication)
      && [undefined, null, false].includes(row.isReserved), 'IMPORT_MODE_UNRESOLVED')
    const target = { environment: row.importEnv.slug, path: row.importPath, environmentId: row.importEnv.id }
    validateScope(target)
    return { id: row.id, from: { environment: scope.environment, path: scope.path }, to: target,
      targetCoverage: targetScope(target) }
  })
}

export function projectSubfolders(data, scope) {
  requireThat(Array.isArray(data?.folders) && data.folders.length <= LIMITS.nodes, 'FOLDER_LIST_SCHEMA')
  const ids = new Set(), paths = new Set()
  return data.folders.map(row => {
    requireThat(uuid(row?.id) && row.envId === scope.environmentId && !ids.has(row.id)
      && [undefined, null, false].includes(row.isReserved), 'FOLDER_SCOPE')
    requireThat(validPath(row.relativePath) && row.relativePath !== '/' && !paths.has(row.relativePath)
      && row.relativePath.split('/').at(-1) === row.name, 'FOLDER_PATH')
    ids.add(row.id); paths.add(row.relativePath)
    const path = scope.path === '/' ? row.relativePath : scope.path + row.relativePath
    const child = { environment: scope.environment, environmentId: scope.environmentId, folderId: row.id, path }
    validateScope(child)
    return child
  })
}

export function newEvidence() {
  return { target: { project: TARGET.project, environment: TARGET.environment, path: TARGET.path },
    scope: 'existing_vercel_sync_sources_and_imports', sourceAndImportCoverage: 'unknown',
    secretReferenceCoverage: 'not_inspected', canCreate: false,
    readPermissions: null, syncs: [], checkedFolders: [], importEdges: [] }
}

export async function inspect(request, evidence = newEvidence()) {
  const read = async (operation, scope) => {
    const response = await request(operation, scope)
    requireThat(response.status === 200, 'METADATA_HTTP')
    return response.data
  }
  evidence.readPermissions = validateReadPermissions(await read('project_permissions'))
  evidence.syncs = projectSyncs(await read('project_vercel_syncs'))
  if (evidence.syncs.some(row => row.directCoverage)) { evidence.sourceAndImportCoverage = 'covered'; return evidence }

  const queue = [], nodes = new Map(), environments = new Map(), environmentIds = new Map()
  const add = scope => {
    validateScope(scope)
    requireThat(uuid(scope.environmentId), 'ENVIRONMENT_SCOPE')
    requireThat(!environments.has(scope.environment) || environments.get(scope.environment) === scope.environmentId, 'ENVIRONMENT_SCOPE')
    requireThat(!environmentIds.has(scope.environmentId) || environmentIds.get(scope.environmentId) === scope.environment, 'ENVIRONMENT_SCOPE')
    environments.set(scope.environment, scope.environmentId); environmentIds.set(scope.environmentId, scope.environment)
    const key = scopeKey(scope), existing = nodes.get(key)
    if (existing) {
      requireThat(!existing.folderId || !scope.folderId || existing.folderId === scope.folderId, 'FOLDER_SCOPE')
      if (!existing.folderId && scope.folderId) existing.folderId = scope.folderId
      return
    }
    requireThat(nodes.size < LIMITS.nodes, 'NODE_LIMIT')
    const node = { environment: scope.environment, path: scope.path, environmentId: scope.environmentId, folderId: scope.folderId }
    nodes.set(key, node); queue.push(node)
  }
  for (const sync of evidence.syncs) {
    add(sync)
    if (sync.includeAllSubFolders) {
      for (const child of projectSubfolders(await read('subfolders', sync), sync)) add(child)
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const scope = queue[index]
    const edges = projectImports(await read('imports', scope), scope)
    requireThat(evidence.importEdges.length + edges.length <= LIMITS.edges, 'EDGE_LIMIT')
    evidence.checkedFolders.push({ environment: scope.environment, path: scope.path, importCount: edges.length })
    evidence.importEdges.push(...edges)
    if (edges.some(edge => edge.targetCoverage)) { evidence.sourceAndImportCoverage = 'covered'; return evidence }
    for (const edge of edges) add(edge.to)
  }
  evidence.sourceAndImportCoverage = 'not_covered'
  return evidence
}

async function main() {
  const report = { identity: TARGET.identity, project: TARGET.project, connection: TARGET.connection,
    result: 'blocked', requests: [], applicationSecretValuesRequested: 0, providerCredentialsRequested: false,
    configurationWrites: 0, identityOrTrustChanges: false }
  try {
    requireThat(process.argv.length === 3 && ['--preflight', '--inspect'].includes(process.argv[2]), 'MODE')
    report.execution = validateExecution({ env: process.env, event: JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')),
      head: git('rev-parse', 'HEAD'), parent: git('rev-parse', 'HEAD^'), changed: git('diff', '--name-only', 'HEAD^', 'HEAD').split('\n').filter(Boolean) })
    if (process.argv[2] === '--preflight') report.result = 'source_verified'
    else {
      const accessToken = await login(process.env, report.requests)
      report.evidence = newEvidence()
      await inspect(metadataClient(accessToken, report.requests), report.evidence)
      report.result = 'inspected'
    }
  } catch (error) { report.error = error instanceof GuardError ? error.code : 'INSPECTION_FAILED'; process.exitCode = 1 }
  const safe = JSON.stringify(report)
  console.log(safe)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    '### Read-only private cloud source scope\n\n```json\n' + safe + '\n```\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()

