// Run only in the existing OIDC Actions job. Real community image, isolated
// PostgreSQL, normal HTTP enrollment/dispatch and unchanged official CLIs.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { login, TARGET as INFI } from './infisical-cloud-capabilities.mjs'
import { smokeAccount } from './self-hosting-cloud-acceptance.mjs'

const execute = promisify(execFile)
const PUBLIC = 'https://app.aspectlylabs.com'
const PROJECT = INFI.project
const check = (v, code) => { if (!v) throw Error('COMMUNITY_' + code) }
const sha = v => createHash('sha256').update(v).digest('hex')
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
// Protocol redirects are inspected and origin/state checked by this driver.
// Never follow one automatically or turn an expected 302/303 into fetch error.
const manualRedirect = (url, init) => fetch(url, { ...init, redirect: 'manual' })

// Production keeps these non-secret location selectors in its live deployment.
// Their effective access project and the normal custody identity decide the read.
export async function readProductionAccessLocation(read) {
  const project = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
  const { envs } = await read('/v10/projects/' + project + '/env')
  check(Array.isArray(envs), 'SOURCE_CONFIG_METADATA')
  const keys = ['MIKKA_BYOS_INFISICAL_PROJECT', 'MIKKA_BYOS_INFISICAL_ENVIRONMENT', 'MIKKA_BYOS_ACCESS_INFISICAL_PATH', 'MIKKA_BYOS_ACCESS_INFISICAL_PROJECT']
  const values = {}
  for (const key of keys) {
    const rows = envs.filter(row => row.key === key && row.target?.includes('production') && !row.gitBranch)
    check(rows.length <= 1 && (rows.length === 1 || key === 'MIKKA_BYOS_ACCESS_INFISICAL_PROJECT'), 'SOURCE_CONFIG_' + key)
    if (rows.length) values[key] = (await read('/v1/projects/' + project + '/env/' + encodeURIComponent(rows[0].id))).value
  }
  const location = { project: values.MIKKA_BYOS_ACCESS_INFISICAL_PROJECT || values.MIKKA_BYOS_INFISICAL_PROJECT,
    environment: values.MIKKA_BYOS_INFISICAL_ENVIRONMENT, path: values.MIKKA_BYOS_ACCESS_INFISICAL_PATH }
  check(UUID.test(location.project) && /^[a-zA-Z0-9_-]{1,32}$/.test(location.environment ?? '')
    && /^\/[a-zA-Z0-9/_-]{1,200}$/.test(location.path ?? ''), 'SOURCE_CONFIG_SCOPE')
  return location
}

export async function readAuthorizedProjection({ location, name, clientId, clientSecret, report, fetcher = fetch }) {
  check(UUID.test(location?.project ?? '') && /^[a-zA-Z0-9_-]{1,32}$/.test(location?.environment ?? '')
    && /^\/[a-zA-Z0-9/_-]{1,200}$/.test(location?.path ?? '') && /^mikka-byos-[a-f0-9-]{36}$/.test(name ?? '')
    && typeof clientId === 'string' && clientId.length > 0 && typeof clientSecret === 'string' && clientSecret.length > 0, 'SOURCE_PROJECTION_SCOPE')
  const request = async (operation, path, init) => {
    let response
    try { response = await fetcher('https://app.infisical.com' + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }) }
    catch { throw Error('COMMUNITY_SOURCE_PROJECTION_NETWORK') }
    ;(report.sourceRequests ??= []).push({ operation, status: response.status })
    check(response.ok, 'SOURCE_PROJECTION_HTTP_' + response.status)
    let value; try { value = await response.json() } catch { throw Error('COMMUNITY_SOURCE_PROJECTION_BODY') }
    return value
  }
  const login = await request('existing_custody_login', '/api/v1/auth/universal-auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId, clientSecret }) })
  check(login.tokenType === 'Bearer' && typeof login.accessToken === 'string' && login.accessToken.length > 0, 'SOURCE_IDENTITY')
  const query = new URLSearchParams({ projectId: location.project, environment: location.environment, secretPath: location.path,
    type: 'shared', version: '1', viewSecretValue: 'true', expandSecretReferences: 'false', includeImports: 'false' })
  const result = await request('authorized_access_projection', '/api/v4/secrets/' + name + '?' + query, {
    method: 'GET', headers: { authorization: 'Bearer ' + login.accessToken } })
  const secret = result.secret
  check(secret?.secretKey === name && secret.version === 1 && !secret.secretValueHidden
    && typeof secret.secretValue === 'string' && secret.secretValue.length > 0 && Buffer.byteLength(secret.secretValue) <= 32768, 'SOURCE_PROJECTION_SCHEMA')
  return secret.secretValue
}

// Metadata only, kept outside artifacts so an independent always() step can
// remove exactly this run's access leaves and VMs after a driver timeout.
export function cleanupScope(value, run) {
  check(/^[1-9][0-9]{5,20}$/.test(run ?? '') && value.run === run && value.project === PROJECT
    && value.environment === 'dev' && value.path === '/release-selfhost-' + run && UUID.test(value.folder)
    && Array.isArray(value.vms) && value.vms.length <= 2 && value.vms.every(id => /^[A-Za-z0-9_-]{8,128}$/.test(id)), 'CLEANUP_SCOPE')
  return value
}

export async function cleanupCommunity(env = process.env) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && env.GITHUB_REF === INFI.ref && env.GITHUB_RUN_ATTEMPT === '1', 'EXECUTION')
  let value
  try { value = JSON.parse(await readFile(env.RUNNER_TEMP + '/mikka-community-cleanup.json', 'utf8')) }
  catch (error) { if (error?.code === 'ENOENT') return; throw Error('COMMUNITY_CLEANUP_JOURNAL') }
  const owned = cleanupScope(value, env.GITHUB_RUN_ID), token = await login(env, [], fetch)
  const request = async (path, method = 'GET', body) => {
    const r = await fetch('https://app.infisical.com' + path, { method, signal: AbortSignal.timeout(20000), redirect: 'error',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    check(r.ok, 'CLEANUP_HTTP_' + r.status); return r.status === 204 ? {} : r.json()
  }
  if (owned.vms.length) {
    const source = resolve(env.RUNNER_TEMP, 'mikka-community-source'), requireSource = createRequire(source + '/package.json')
    const { Sandbox } = await import(pathToFileURL(requireSource.resolve('e2b')))
    const secret = await request('/api/v4/secrets/E2B_API_KEY?' + new URLSearchParams({ projectId: PROJECT, environment: 'prod', secretPath: '/vercel', type: 'shared', viewSecretValue: 'true', expandSecretReferences: 'true', includeImports: 'false' }))
    for (const id of owned.vms) { try { await Sandbox.kill(id, { apiKey: secret.secret.secretValue }) } catch (error) { check(error?.status === 404 || error?.statusCode === 404, 'VM_CLEANUP') } }
  }
  const folders = await request('/api/v2/folders?' + new URLSearchParams({ projectId: PROJECT, environment: 'dev', path: '/', recursive: 'true' }))
  const folder = folders.folders.find(f => f.id === owned.folder)
  if (folder) {
    check([folder.path, folder.relativePath].includes(owned.path), 'CLEANUP_FOLDER')
    const rows = await request('/api/v4/secrets?' + new URLSearchParams({ projectId: PROJECT, environment: 'dev', secretPath: owned.path,
      viewSecretValue: 'false', expandSecretReferences: 'false', includeImports: 'false', recursive: 'false' }))
    check(rows.secrets.length <= 2 && rows.secrets.every(s => s.secretPath === owned.path && /^mikka-byos-[a-f0-9-]{36}$/.test(s.secretKey)), 'CLEANUP_SECRET_SCOPE')
    for (const row of rows.secrets) await request('/api/v4/secrets/' + row.secretKey, 'DELETE', { projectId: PROJECT, environment: 'dev', secretPath: owned.path, type: 'shared' })
    await request('/api/v2/folders/' + owned.folder, 'DELETE', { projectId: PROJECT, environment: 'dev' })
  }
  console.log(JSON.stringify({ kind: 'community-independent-cleanup', run: env.GITHUB_RUN_ID, ownAccessFolderAbsent: true, ownVmCount: owned.vms.length, status: 'passed' }))
}

export function accessFixture(raw, row, target, now = Date.now()) {
  check(sha(raw) === row.accessDigest, 'SOURCE_DIGEST')
  const value = JSON.parse(raw)
  check(value.schema === 1 && value.ownerId === row.ownerId && value.workspaceId === row.workspaceId
    && value.connectionId === row.id && value.provider === row.provider, 'SOURCE_SCOPE')
  for (const payload of [value.payload, value.payload?.siwc].filter(Boolean)) {
    check(!('refresh_token' in payload) && !('id_token' in payload), 'ACCESS_ONLY')
  }
  check(typeof value.payload?.access_token === 'string' && Date.parse(value.payload.expired) >= now + 1_200_000, 'SOURCE_EXPIRY')
  check(UUID.test(target.workspaceId) && UUID.test(target.connectionId) && /^[A-Za-z0-9_-]{1,128}$/.test(target.ownerId), 'FIXTURE_SCOPE')
  value.ownerId = target.ownerId; value.workspaceId = target.workspaceId; value.connectionId = target.connectionId
  const encoded = JSON.stringify(value)
  return { value: encoded, digest: sha(encoded) }
}

// A provider-specific source/fixture failure cannot suppress the other path.
export async function independentProviders(providers, stage, work) {
  for (const provider of providers) {
    provider.receipt.stage = stage
    try { await work(provider) }
    catch (error) {
      Object.assign(provider.receipt, { status: 'failed',
        code: /^(COMMUNITY_[A-Z0-9_]+|startup_[a-z0-9_]{1,80})$/.test(error?.message ?? '') ? error.message : 'COMMUNITY_PROVIDER_FAILED',
        errorClass: 'Error' })
    }
  }
}

export async function runCommunity(env = process.env) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && env.GITHUB_REF === INFI.ref && env.GITHUB_RUN_ATTEMPT === '1', 'EXECUTION')
  const source = resolve(env.RUNNER_TEMP, 'mikka-community-source')
  const requireSource = createRequire(source + '/package.json')
  const { Pool } = requireSource('pg')
  const { Sandbox } = await import(pathToFileURL(requireSource.resolve('e2b')))
  const { createSessionClient, readProductionWorkerRelease, watchRun } = await import(pathToFileURL(source + '/scripts/acceptance/cloud-startup.mjs'))
  const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim()
  check(/^[a-f0-9]{40}$/.test(revision) && revision === env.MIKKA_COMMUNITY_REVISION, 'REVISION')
  const report = { kind: 'real-community-subscriptions', revision, cases: [], cleanup: {}, stage: 'source', status: 'failed',
    sourceRequests: [], credentialFixture: 'existing_authorized_access_projection', freshProviderOAuth: false, refreshGrantCopied: false, canonicalGrantPresent: false }
  const name = 'mikka-community-' + env.GITHUB_RUN_ID
  const databasePassword = randomBytes(24).toString('hex'), key = randomBytes(32).toString('base64')
  const devPath = '/release-selfhost-' + env.GITHUB_RUN_ID
  const docker = async args => (await execute('docker', args, { maxBuffer: 4 * 1024 * 1024, timeout: 120000 })).stdout.trim()
  let tunnel, privatePool, localPool, cloud, community, serverRegistered = false, infToken, infIssued = 0, ownFolder = false, sourceConfig
  const createdSecrets = [], sessions = [], resources = []
  const journal = { run: env.GITHUB_RUN_ID, project: PROJECT, environment: 'dev', path: devPath, folder: null, vms: [] }
  const saveJournal = () => writeFile(env.RUNNER_TEMP + '/mikka-community-cleanup.json', JSON.stringify(journal), { mode: 0o600 })
  const inf = async (path, method = 'GET', body) => {
    if (!infToken || Date.now() - infIssued > 600000) { infToken = await login(env, [], fetch); infIssued = Date.now() }
    const response = await fetch('https://app.infisical.com' + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { authorization: 'Bearer ' + infToken, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    check(response.ok, 'INFISICAL_' + response.status)
    return response.status === 204 ? {} : response.json()
  }
  const secret = async (path, name, environment = 'prod', expand = true) => {
    const result = await inf('/api/v4/secrets/' + name + '?' + new URLSearchParams({ projectId: PROJECT, environment, secretPath: path,
      type: 'shared', viewSecretValue: 'true', expandSecretReferences: String(expand), includeImports: 'false', ...(!expand ? { version: '1' } : {}) }))
    check(typeof result.secret?.secretValue === 'string' && result.secret.secretKey === name, 'SECRET_SCHEMA')
    return result.secret.secretValue
  }
  try {
    infToken = await login(env, [], fetch); infIssued = Date.now()
    const [email, password, database, custodyId, custodySecret, e2bKey] = await Promise.all([
      secret('/', 'SMOKE_OWNER_EMAIL'), secret('/', 'SMOKE_OWNER_PASSWORD'), secret('/vercel', 'MIKKA_DATABASE_URL'),
      secret('/vercel', 'MIKKA_BYOS_CUSTODY_CLIENT_ID'), secret('/vercel', 'MIKKA_BYOS_CUSTODY_CLIENT_SECRET'), secret('/vercel', 'E2B_API_KEY'),
    ])
    smokeAccount({ SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: password })
    cloud = createSessionClient(PUBLIC, manualRedirect)
    await cloud.json('/api/auth/sign-in/email', post({ email, password })); sessions.push(cloud)
    const identity = await cloud.json('/api/auth/get-session')
    check(identity.user?.email === email && identity.user.emailVerified === true, 'ACCOUNT')
    sourceConfig = await readProductionWorkerRelease({ token: env.VERCEL_TEAM_TOKEN })
    report.worker = { source: sourceConfig.sourceCommit, sha: sourceConfig.workerSha, templates: sourceConfig.templates }
    const expectedWorker = (await execute('python3', ['scripts/e2b/build-template.py', '--worker-hash', '--source-ref', revision], { cwd: source })).stdout.trim()
    check(expectedWorker === sourceConfig.workerSha, 'WORKER_VERSION')
    report.publicBuild = (await cloud.json('/api/version')).build
    const sharedBuilds = [revision, env.MIKKA_COMMUNITY_SHARED_COMPATIBLE_REVISION]
    check(env.MIKKA_COMMUNITY_SHARED_COMPATIBLE_REVISION === '9ea7b2cd61deb724f20330906f86df6df2cd9828' && sharedBuilds.includes(report.publicBuild), 'PUBLIC_VERSION')
    report.sharedControlPlaneCompatibility = 'A23_to_9ea_protected_paths_byte_identical'
    privatePool = new Pool({ connectionString: database, max: 1, ssl: { rejectUnauthorized: true } })
    await privatePool.query('BEGIN READ ONLY')
    // The normal account API must expose the source before its exact metadata
    // can be read. No production row is inserted or modified.
    const choices = (await cloud.json('/api/workspace')).choices
    check(Array.isArray(choices), 'WORKSPACES')
    const { api: vercelApi } = await import(pathToFileURL(source + '/scripts/e2b/publish-template-env.mjs'))
    const productionLocation = await readProductionAccessLocation(path => vercelApi(path, { token: env.VERCEL_TEAM_TOKEN }))
    const [legacyPath, legacyEnvironment] = await Promise.all([secret('/vercel', 'MIKKA_BYOS_ACCESS_INFISICAL_PATH'), secret('/vercel', 'MIKKA_BYOS_INFISICAL_ENVIRONMENT')])
    report.sourceConfiguration = { origin: 'existing_vercel_production', accessProjectMatchesLegacy: productionLocation.project === PROJECT,
      accessPathMatchesLegacy: productionLocation.path === legacyPath, environmentMatchesLegacy: productionLocation.environment === legacyEnvironment }
    const sources = []
    const providers = [['claude', 'claude_code', 'claude-haiku-5-5'], ['codex', 'codex', 'gpt-6-luna']].map(([provider, harness, model]) => {
      const receipt = { harness, model, status: 'failed', cleanup: {} }; report.cases.push(receipt)
      return { provider, harness, model, receipt }
    })
    await independentProviders(providers, 'source-authorization', async source => {
      const { provider, harness, model } = source
      let chosen, selectedWorkspace
      for (const workspace of choices.filter(w => w.kind === 'team')) {
        const view = await cloud.rpc('model-order.getModelOrder', [workspace.id])
        const candidates = (view.candidates ?? []).filter(c => c.harness === harness && c.model === model && c.source?.kind === 'subscription')
        if (candidates.length === 1) { chosen = candidates[0]; selectedWorkspace = workspace.id; break }
      }
      check(chosen, 'AUTHORIZED_' + provider.toUpperCase())
      const result = await privatePool.query(`SELECT id::text,"ownerId","workspaceId",provider,state,epoch,"credentialVersion","providerSubject","accessSecretName","accessDigest","modelCatalog",quota FROM byos_connections WHERE id=$1 AND provider=$2 AND state='connected'`, [chosen.source.connectionId, provider])
      check(result.rows.length === 1, 'CONNECTION')
      const row = result.rows[0]
      check(UUID.test(row.id) && /^mikka-byos-[a-f0-9-]{36}$/.test(row.accessSecretName) && /^[a-f0-9]{64}$/.test(row.accessDigest), 'CONNECTION_METADATA')
      // Path/environment are the existing runtime configuration, never a
      // guessed canonical-grant path. Only the immutable access leaf is read.
      Object.assign(source.receipt, { sourceConnectionHash: sha(row.id).slice(0, 16), sourceCredentialVersion: Number(row.credentialVersion), sourceAccessNameHash: sha(row.accessSecretName).slice(0, 16) })
      if (report.sourceConfiguration.accessProjectMatchesLegacy && report.sourceConfiguration.accessPathMatchesLegacy && report.sourceConfiguration.environmentMatchesLegacy) {
        try { await secret(legacyPath, row.accessSecretName, legacyEnvironment, false); source.receipt.actionsOidcProjectionStatus = 200 }
        catch (error) { const match = /^COMMUNITY_INFISICAL_(\d{3})$/.exec(error?.message ?? ''); source.receipt.actionsOidcProjectionStatus = match ? Number(match[1]) : 'OTHER' }
      }
      const raw = await readAuthorizedProjection({ location: productionLocation, name: row.accessSecretName,
        clientId: custodyId, clientSecret: custodySecret, report })
      Object.assign(source, { row, raw, selectedWorkspace }); sources.push(source)
    })
    await privatePool.query('COMMIT'); await privatePool.end(); privatePool = undefined
    check(sources.length > 0, 'NO_AUTHORIZED_SOURCES')
    // This new folder must not be recursively exported by an existing Sync.
    const syncs = await inf('/api/v1/secret-syncs/vercel?projectId=' + PROJECT)
    check(syncs.secretSyncs.every(s => s.environment?.slug !== 'dev' || !(s.folder?.path === '/' && s.syncOptions?.includeAllSubFolders)), 'NO_DEV_EXPORT')
    const folders = await inf('/api/v2/folders?' + new URLSearchParams({ projectId: PROJECT, environment: 'dev', path: '/', recursive: 'true' }))
    check(!folders.folders.some(f => [f.path, f.relativePath].includes(devPath)), 'FRESH_FOLDER')
    const folder = await inf('/api/v2/folders', 'POST', { projectId: PROJECT, environment: 'dev', path: '/', name: devPath.slice(1) })
    check(folder.folder?.id, 'FOLDER_CREATED'); ownFolder = folder.folder.id; journal.folder = ownFolder; await saveJournal()
    report.stage = 'community-start'
    await docker(['network', 'create', name]); resources.push(['network', name])
    await docker(['run', '-d', '--name', name + '-pg', '--network', name, '-p', '127.0.0.1:55439:5432', '-e', 'POSTGRES_USER=mikka', '-e', 'POSTGRES_DB=community_release_e2e', '-e', 'POSTGRES_PASSWORD=' + databasePassword, 'postgres:17-alpine']); resources.push(['container', name + '-pg'])
    await docker(['run', '-d', '--name', name + '-mail', '--network', name, '-p', '127.0.0.1:58025:8025', 'axllent/mailpit:v1.27.4']); resources.push(['container', name + '-mail'])
    tunnel = spawn(env.RUNNER_TEMP + '/mikka-cloudflared', ['tunnel', '--url', 'http://127.0.0.1:3000', '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const origin = await new Promise((resolveReady, reject) => {
      let text = ''; const timer = setTimeout(() => reject(Error('COMMUNITY_TUNNEL')), 45000)
      const data = chunk => { text = (text + chunk).slice(-64000); const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text); if (match && text.includes('Registered tunnel connection')) { clearTimeout(timer); resolveReady(match[0]) } }
      tunnel.stdout.on('data', data); tunnel.stderr.on('data', data); tunnel.on('error', () => reject(Error('COMMUNITY_TUNNEL')))
    })
    report.origin = origin
    const appEnv = { BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: key, WORKSPACE_SECRETS_KEY: key, CREDENTIAL_MASTER_KEY: key,
      DEVICE_GATEWAY_PUSH_SECRET: key, CRON_SECRET: key, MIKKA_EXTERNAL_CRON: '1', MIKKA_EDITION: 'community',
      DATABASE_URL: `postgres://mikka:${databasePassword}@${name}-pg:5432/community_release_e2e`,
      MIKKA_DATABASE_URL: `postgres://mikka:${databasePassword}@${name}-pg:5432/community_release_e2e`,
      SMTP_URL: `smtp://${name}-mail:1025`, MIKKA_EMAIL_FROM: 'Mikka acceptance <login@selfhost.example.test>',
      MIKKA_BYOS_ENABLED: '1', MIKKA_BYOS_ENROLLMENT_ENABLED: '1', MIKKA_BYOS_SHARED_CUSTODY_IDENTITY: '1',
      MIKKA_BYOS_INFISICAL_ORIGIN: 'https://app.infisical.com', MIKKA_BYOS_INFISICAL_PROJECT: PROJECT,
      MIKKA_BYOS_INFISICAL_ENVIRONMENT: 'dev', MIKKA_BYOS_INFISICAL_PATH: devPath + '-unused-custody',
      MIKKA_BYOS_ACCESS_INFISICAL_PATH: devPath, MIKKA_BYOS_CUSTODY_CLIENT_ID: custodyId, MIKKA_BYOS_CUSTODY_CLIENT_SECRET: custodySecret }
    const startApp = async () => {
      const original = {}; for (const [k, v] of Object.entries(appEnv)) { original[k] = process.env[k]; process.env[k] = v }
      try { await docker(['run', '-d', '--name', name + '-app', '--network', name, '-p', '127.0.0.1:3000:3000',
        '--mount', `type=volume,source=${name}-data,target=/data`, ...Object.keys(appEnv).flatMap(k => ['--env', k]), 'ghcr.io/alexj11324/mikka:' + revision]) }
      finally { for (const [k, v] of Object.entries(original)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
    }
    await startApp(); resources.push(['container', name + '-app'], ['volume', name + '-data'])
    // Bounded external service readiness; model/thread reads below use live push.
    let ready = false
    for (let i = 0; i < 60 && !ready; i++) {
      try { const r = await fetch(origin + '/mikka/api/version', { signal: AbortSignal.timeout(5000) }); ready = r.ok && (await r.json()).build === revision } catch { /* transport not ready */ }
      if (!ready) await new Promise(resolveReady => setTimeout(resolveReady, 2000))
    }
    check(ready, 'STARTUP')
    community = createSessionClient(origin, manualRedirect)
    // Same authorized shared account, independently registered on this empty
    // community installation. Verification mail is delivered to local Mailpit.
    const mailbox = new WebSocket('ws://127.0.0.1:58025/api/events'); await once(mailbox, 'open', { signal: AbortSignal.timeout(15000) })
    const mail = new Promise((resolveMail, reject) => {
      const timer = setTimeout(() => reject(Error('COMMUNITY_MAIL')), 30000)
      mailbox.onmessage = event => { const v = JSON.parse(event.data); if (v.Type === 'new' && v.Data?.To?.some(t => t.Address === email)) { clearTimeout(timer); resolveMail(v.Data.ID) } }
    })
    await community.json('/api/auth/sign-up/email', post({ name: 'Mikka release acceptance', email, password }))
    const message = await (await fetch('http://127.0.0.1:58025/api/v1/message/' + await mail)).json(); mailbox.close()
    const link = String(message.Text).match(/https:\/\/[^\s]+\/mikka\/api\/auth\/verify-email\?[^\s]+/)?.[0]
    check(link && new URL(link).origin === origin, 'VERIFICATION_LINK')
    const verified = await community.request(new URL(link).pathname.replace('/mikka', '') + new URL(link).search)
    check(verified.status === 302, 'VERIFICATION')
    const nativeLogin = await community.request('/api/auth/sign-in/email', post({ email, password }))
    check(nativeLogin.ok, 'NATIVE_LOGIN')
    const nativeBearer = nativeLogin.headers.get('set-auth-token'); await nativeLogin.body?.cancel(); sessions.push(community)
    check(typeof nativeBearer === 'string' && nativeBearer.length >= 32 && nativeBearer.length <= 512, 'NATIVE_BEARER')
    const nativeRpc = await fetch(origin + '/mikka/api/desktop/rpc', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { origin, authorization: 'Bearer ' + nativeBearer, 'content-type': 'application/json', 'x-mikka-client': 'desktop', 'x-mikka-desktop-protocol': '1' },
      body: JSON.stringify({ version: 1, action: 'agents.listAgents', args: [] }) })
    check(nativeRpc.ok && (await nativeRpc.json()).ok === true, 'NATIVE_RPC')
    report.nativeSession = { signedBearerAccepted: true, cookiesSent: false, status: nativeRpc.status, action: 'agents.listAgents', hasSignaturePadding: nativeBearer.endsWith('=') }

    const own = (await community.json('/api/auth/get-session')).user
    check(own.email === email && own.emailVerified === true, 'COMMUNITY_IDENTITY')
    const workspace = (await community.json('/api/workspace')).workspace
    localPool = new Pool({ connectionString: `postgres://mikka:${databasePassword}@127.0.0.1:55439/community_release_e2e`, max: 2 })
    appEnv.MIKKA_SERVER_ADMIN_USER_IDS = own.id
    await docker(['rm', '-f', '-v', name + '-app']); await startApp()
    for (let i = 0; i < 30; i++) { try { if ((await community.json('/api/version')).build === revision) break } catch {} await new Promise(r => setTimeout(r, 1000)) }
    report.stage = 'normal-cloud-binding'
    await community.json('/api/cloud/connect', post({ action: 'register', name: 'Mikka community release ' + env.GITHUB_RUN_ID })); serverRegistered = true
    const binding = await community.json('/api/cloud/connect', post({ action: 'bind', scopes: ['github'] }))
    check(typeof binding.url === 'string' && new URL(binding.url).origin === PUBLIC, 'BINDING_URL')
    const consent = await cloud.request(binding.url.slice(PUBLIC.length + '/mikka'.length))
    const bootstrap = /id="cloud-bootstrap"[^>]*>([\s\S]*?)<\/script>/.exec(await consent.text())
    check(bootstrap, 'CLOUD_CONSENT')
    const model = JSON.parse(bootstrap[1]).model, personal = model.workspaces.find(w => w.kind === 'personal')
    check(personal, 'PERSONAL')
    const approved = await cloud.request('/cloud/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request_id: model.requestId, csrf_token: model.csrfToken, workspace_id: personal.id, approve: 'true' }) })
    check(approved.status === 302, 'CLOUD_APPROVAL')
    const callback = new URL(approved.headers.get('location')); check(callback.origin === origin, 'CALLBACK_ORIGIN')
    const bound = await community.request(callback.pathname.slice('/mikka'.length) + callback.search)
    check(bound.status === 303, 'CLOUD_CALLBACK')
    report.cloudBinding = true
    const installation = (await cloud.json('/api/integrations/github')).repositories?.find(r => r.fullName === 'alexj11324/Mikka')?.installationId
    check(installation, 'GITHUB_INSTALLATION')
    const installing = await community.request('/api/integrations/github/install')
    check(installing.status === 302, 'GITHUB_PREPARATION')
    const installUrl = new URL(installing.headers.get('location'))
    check(installUrl.origin === 'https://github.com' && installUrl.searchParams.has('state'), 'GITHUB_STATE')
    const setup = await cloud.request('/cloud/v1/github/setup?' + new URLSearchParams({ installation_id: String(installation), setup_action: 'install', state: installUrl.searchParams.get('state') }))
    check(setup.status === 302, 'GITHUB_SETUP')
    check((await community.json('/api/integrations/github')).repositories?.some(r => r.fullName === 'alexj11324/Mikka'), 'COMMUNITY_GITHUB')
    report.githubPreparation = true
    // This read-only task has a real, bounded verification command. Without
    // one, a normal submitted run may correctly remain stopped/unverified.
    const verifyCommand = `node -e "if(!require('node:fs').readFileSync('README.md','utf8').trim())process.exit(1)" && git diff --exit-code && git diff --cached --exit-code`
    const verification = await community.json('/api/integrations/github/repositories/verification', { ...post({ repository: 'alexj11324/Mikka', verifyCommand }), method: 'PATCH' })
    check(verification.verifyCommand === verifyCommand, 'VERIFICATION_COMMAND')
    report.stage = 'subscription-fixtures'
    await independentProviders(sources, 'subscription-fixture', async s => {
      const connectionId = randomUUID(), secretName = 'mikka-byos-' + randomUUID()
      const fixture = accessFixture(s.raw, s.row, { ownerId: own.id, workspaceId: workspace.id, connectionId })
      await inf('/api/v4/secrets/' + secretName, 'POST', { projectId: PROJECT, environment: 'dev', secretPath: devPath, type: 'shared', secretValue: fixture.value }); createdSecrets.push(secretName)
      // Connected metadata requires a grant reference even for this bounded
      // access-only fixture. Its deliberately absent grant cannot resolve in
      // the unused custody path; no canonical or refresh grant is created.
      const absentGrant = 'mikka-byos-' + randomUUID()
      await localPool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,epoch,"credentialVersion","providerSubject","accessSecretName","accessDigest","modelCatalog",quota,"secretName","secretDigest") VALUES ($1,$2,$3,$4,'connected',1,1,$5,$6,$7,$8,$9,$10,$11)`,
        [connectionId, own.id, workspace.id, s.provider, s.row.providerSubject, secretName, fixture.digest, JSON.stringify({ revision: '1', models: [s.model] }), s.row.quota, absentGrant, sha('absent-canonical-grant:' + connectionId)])
      await localPool.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES($1,$2,$3,'catalogue',$4,1,$5,$6)`, [randomUUID(), own.id, workspace.id, connectionId, s.provider + '_cpa', s.model])
      s.localConnection = connectionId; s.ready = true; delete s.raw
    })
    check(sources.some(s => s.ready), 'NO_READY_SOURCES')
    // Obtain a genuine local MCP OAuth token through DCR, PKCE and consent.
    report.stage = 'mcp-oauth'
    const redirect = origin + '/mikka/release-mcp-callback'
    const client = await community.json('/api/auth/oauth2/register', post({ client_name: 'Mikka release ' + env.GITHUB_RUN_ID, redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: 'mikka' }))
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(24).toString('base64url')
    const authQuery = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: redirect, scope: 'mikka', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: origin + '/mikka/api/mcp' })
    const authorize = await community.request('/api/auth/oauth2/authorize?' + authQuery)
    check(authorize.status === 302 || authorize.status === 200, 'MCP_AUTHORIZE')
    const consentLocation = authorize.status === 302 ? authorize.headers.get('location') : (await authorize.json()).url
    const localConsent = new URL(consentLocation, origin)
    check(localConsent.origin === origin && localConsent.pathname.endsWith('/oauth/consent')
      && localConsent.searchParams.has('sig') && localConsent.searchParams.get('state') === state, 'MCP_SIGNED_CONSENT')
    // The official oauthProviderClient normally adds the signed page query.
    // Send exactly that query with the ordinary consent request.
    const agreed = await community.json('/api/auth/oauth2/consent', post({ accept: true, oauth_query: localConsent.search.slice(1) }))
    const returned = new URL(agreed.url); check(returned.origin === origin && returned.searchParams.get('state') === state && returned.searchParams.has('code'), 'MCP_CONSENT')
    const exchanged = await community.json('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: returned.searchParams.get('code'), redirect_uri: redirect, code_verifier: verifier, resource: origin + '/mikka/api/mcp' }) })
    check(exchanged.access_token?.startsWith('mka_'), 'MCP_TOKEN')
    let sequence = 0
    const mcp = async (method, params) => {
      const response = await fetch(origin + '/mikka/api/mcp', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000), headers: {
        authorization: 'Bearer ' + exchanged.access_token, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) })
      check(response.ok, 'MCP_HTTP_' + response.status)
      const eventStream = response.headers.get('content-type')?.includes('text/event-stream')
      const text = await response.text(), answer = eventStream ? JSON.parse(text.split('\n').filter(l => l.startsWith('data:')).at(-1).slice(5)) : JSON.parse(text)
      check(!answer.error && !answer.result?.isError, 'MCP_RESULT')
      return answer.result?.structuredContent ?? (answer.result?.content?.[0]?.text ? JSON.parse(answer.result.content[0].text) : answer.result)
    }
    await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mikka-community-release', version: '1.0.0' } })
    for (const s of sources.filter(source => source.ready)) {
      const row = s.receipt
      let sandbox, deviceId, runId, issueId
      try {
        report.stage = 'thread-' + s.provider
        row.stage = 'source-authorization'
        const authorization = await cloud.rpc('model-order.getModelOrder', [s.selectedWorkspace])
        check(authorization.candidates?.some(c => c.harness === s.harness && c.model === s.model
          && c.source?.kind === 'subscription' && c.source.connectionId === s.row.id), 'SOURCE_STILL_AUTHORIZED')
        row.stage = 'machine'
        const kind = s.provider === 'claude' ? 'claude' : 'codex'
        sandbox = await Sandbox.create(sourceConfig.templates[kind], { apiKey: e2bKey, timeoutMs: 480000, metadata: { application: 'mikka-selfhost-release', runId: env.GITHUB_RUN_ID, kind } })
        journal.vms.push(sandbox.sandboxId); await saveJournal()
        check((await sandbox.files.read('/opt/mikka/worker-source-sha', { user: 'root' })).trim() === sourceConfig.workerSha, 'VM_WORKER')
        // The existing strict helper conserves the official binary and uses
        // normal enrollment. Only its fixed acceptance origin is adapted to
        // this run's attested community server; no runtime source is changed.
        const helper = (await readFile(source + '/scripts/e2b/acceptance-daemon.mts', 'utf8')).replace("origin !== 'https://app.aspectlylabs.com'", 'origin !== ' + JSON.stringify(origin))
        check(helper.includes('origin !== ' + JSON.stringify(origin)), 'HELPER_ORIGIN')
        await sandbox.files.write('/opt/mikka/worker/scripts/e2b/community-acceptance-daemon.mts', helper, { user: 'root' })
        row.stage = 'enrollment'
        const grant = await community.json('/api/devices/enrollment', post({}))
        await sandbox.commands.run('install -d -m 700 /run/mikka-template-acceptance', { user: 'root', timeoutMs: 10000 })
        await sandbox.files.write('/run/mikka-template-acceptance/enrollment', grant.token, { user: 'root' })
        const proof = await new Promise(async (resolveReady, reject) => {
          let buffer = ''; const timer = setTimeout(() => reject(Error('COMMUNITY_DEVICE_READY')), 90000)
          try {
            const child = await sandbox.commands.run('cat /run/mikka-template-acceptance/enrollment | runuser -u user -- env PATH=/opt/mikka/runtime/node/bin:/opt/mikka/runtime/harness-bin:/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin MIKKA_ACCEPTANCE_ORIGIN=' + origin + ' MIKKA_ACCEPTANCE_HARNESS=' + s.harness + ' /opt/mikka/worker/packages/daemon/node_modules/.bin/tsx /opt/mikka/worker/scripts/e2b/community-acceptance-daemon.mts', {
              user: 'root', background: true, timeoutMs: 0, onStdout: text => { buffer = (buffer + text).slice(-65536); const match = /^mikka-template-device (\{[^\r\n]+\})$/m.exec(buffer); if (match) { clearTimeout(timer); resolveReady(JSON.parse(match[1])) } }, onStderr() {} })
            void child.wait().then(() => { clearTimeout(timer); reject(Error('COMMUNITY_DEVICE_EXIT')) }, () => { clearTimeout(timer); reject(Error('COMMUNITY_DEVICE_EXIT')) })
          } catch { clearTimeout(timer); reject(Error('COMMUNITY_DEVICE_START')) }
        })
        check(UUID.test(proof.deviceId) && proof.harness === s.harness && /^[a-f0-9]{64}$/.test(proof.binarySha256), 'OFFICIAL_PROOF')
        deviceId = proof.deviceId; row.officialCli = { version: proof.version, binarySha256: proof.binarySha256 }; row.workerSha = sourceConfig.workerSha
        row.stage = 'agents'
        const agents = await community.rpc('agents.listAgents', []), agent = agents.find(a => a.deviceId === deviceId && a.harness === s.harness)
        check(agent, 'AGENT')
        row.stage = 'model-selection'
        await community.rpc('model-order.changeModelOrder', [{ kind: 'location', location: 'local' }, workspace.id])
        const order = await community.rpc('model-order.getModelOrder', [workspace.id])
        for (const entry of order.entries) await community.rpc('model-order.changeModelOrder', [{ kind: 'remove', id: entry.id }, workspace.id])
        await community.rpc('model-order.changeModelOrder', [{ kind: 'add', entries: [{ harness: s.harness, model: s.model, source: { kind: 'subscription', connectionId: s.localConnection } }] }, workspace.id])
        await community.rpc('model-order.changeModelOrder', [{ kind: 'preferred', harness: s.harness }, workspace.id])
        const sampleId = randomUUID(), marker = 'STARTUP_OK_' + sampleId
        row.stage = 'create-issue'
        const issue = await mcp('tools/call', { name: 'create_issue', arguments: { title: 'Self-hosted ' + kind + ' release validation', body: 'Read README.md using the normal file/shell tool. Do not change any file, commit, branch or push. After the successful tool call, reply exactly ' + marker + '. This is a read-only release verification task.', priority: 'low' } })
        issueId = issue.issue?.id ?? issue.id; check(UUID.test(issueId), 'ISSUE')
        row.stage = 'dispatch'
        const queued = await mcp('tools/call', { name: 'dispatch_run', arguments: { issueId, agentId: agent.id, repo: 'alexj11324/Mikka', requestKey: 'selfhost:' + sampleId, note: 'Use exactly ' + s.model + ' on this subscription. Read-only; finish with ' + marker } })
        runId = queued.runId ?? queued.thread?.runId; check(UUID.test(runId), 'RUN')
        const record = { runId, issueId, sampleId, harness: s.harness, requireReply: true, requireReplyAfterTool: true, requireTerminal: true, minToolCalls: 1 }
        row.stage = 'full-thread'
        await watchRun(community, record, 240000, WebSocket, Date.now)
        check(['succeeded', 'completed'].includes(record.lastStatus) && record.replyVerifiedAfterTool && record.toolCalls.some(t => t.outcome === 'ok'), 'THREAD_COMPLETE')
        row.stage = 'provenance'
        const evidence = (await community.json('/api/runs/' + runId + '/evidence')).run
        check(evidence.model === s.model && evidence.credentialType === 'subscription' && evidence.harness === s.harness
          && evidence.executionIdentity?.resourceBindings?.some(r => r.kind === 'device' && r.id === deviceId), 'RUN_PROVENANCE')
        Object.assign(row, { status: 'passed', runId, issueId, successfulTool: true, replyAfterTool: true, terminal: record.lastStatus,
          credentialType: evidence.credentialType, subscriptionRoute: evidence.subscriptionRoute })
      } catch (error) { row.code = /^(COMMUNITY_[A-Z0-9_]+|startup_[a-z0-9_]{1,80})$/.test(error?.message ?? '') ? error.message : 'COMMUNITY_THREAD_FAILED'; row.errorClass = error?.constructor?.name === 'CommandExitError' ? 'CommandExitError' : 'Error' }
      finally {
        if (!deviceId && sandbox) { try { const proof = JSON.parse(await sandbox.files.read('/home/user/.mikka/template-acceptance/device-proof.json', { user: 'root' })); if (UUID.test(proof.deviceId) && proof.harness === s.harness) deviceId = proof.deviceId } catch { /* registration may not have completed */ } }
        if (runId) { try { await community.rpc('agents.stopRun', [runId]); row.cleanup.runStopped = true } catch { row.cleanup.runStopped = false } }
        if (deviceId) { try { await community.rpc('agents.removeDevice', [deviceId]); row.cleanup.deviceRemoved = true } catch { row.cleanup.deviceRemoved = false } }
        if (sandbox) { try { await sandbox.kill(); row.cleanup.vmStopped = true; journal.vms = journal.vms.filter(id => id !== sandbox.sandboxId); await saveJournal() } catch { row.cleanup.vmStopped = false } }
      }
    }
    check(report.cases.length === 2 && report.cases.every(c => c.status === 'passed' && c.cleanup.vmStopped && c.cleanup.deviceRemoved), 'BOTH_THREADS')
    report.publicFinalBuild = (await cloud.json('/api/version')).build
    check(sharedBuilds.includes(report.publicFinalBuild), 'PUBLIC_CHANGED')
    check(JSON.stringify(await readProductionWorkerRelease({ token: env.VERCEL_TEAM_TOKEN })) === JSON.stringify(sourceConfig), 'WORKER_CHANGED')
    report.status = 'passed'
  } catch (error) { report.code = /^COMMUNITY_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'COMMUNITY_FAILED'; report.causeCode = ['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error?.cause?.code) ? error.cause.code : 'OTHER' }
  finally {
    if (serverRegistered) { try { await community.json('/api/cloud/disconnect', post({ action: 'server' })); report.cleanup.cloudServerRevoked = true } catch { report.cleanup.cloudServerRevoked = false } }
    for (const client of sessions.reverse()) { try { await client.json('/api/auth/sign-out', post({})); report.cleanup.sessionsClosed = (report.cleanup.sessionsClosed ?? true) && true } catch { report.cleanup.sessionsClosed = false } }
    await privatePool?.end(); await localPool?.end()
    if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) { const exited = once(tunnel, 'exit'); tunnel.kill('SIGTERM'); await exited.catch(() => {}) }
    for (const [kind, target] of resources.filter(([k]) => k === 'container').reverse()) { try { await docker(['rm', '-f', '-v', target]) } catch { report.cleanup.docker = false } }
    for (const [kind, target] of resources.filter(([k]) => k !== 'container').reverse()) { try { await docker([kind, 'rm', target]) } catch { report.cleanup.docker = false } }
    for (const name of createdSecrets) { try { await inf('/api/v4/secrets/' + name, 'DELETE', { projectId: PROJECT, environment: 'dev', secretPath: devPath, type: 'shared' }) } catch { report.cleanup.accessSecretsRemoved = false } }
    if (ownFolder) { try { await inf('/api/v2/folders/' + ownFolder, 'DELETE', { projectId: PROJECT, environment: 'dev' }); report.cleanup.ownFolderRemoved = true } catch { report.cleanup.ownFolderRemoved = false } }
    if (Object.values(report.cleanup).some(v => v === false)) report.status = 'failed'
    await mkdir('.artifacts/self-hosting', { recursive: true })
    await writeFile('.artifacts/self-hosting/community-subscriptions.json', JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { if (process.argv[2] === '--cleanup') await cleanupCommunity(); else if ((await runCommunity()).status !== 'passed') process.exitCode = 1 }
  catch { console.log(JSON.stringify({ status: 'failed', code: 'COMMUNITY_GUARD' })); process.exitCode = 1 }
}

// Release checkpoint: Apple status is read-only, separate from device acceptance.

// Final release checkpoint: public ce67; production execution follows private main READY.

// Public protocol checkpoint: ce67 bridge; native/full threads follow the final fixed source.

// Public release checkpoint: dispatch uses the commit subject prefix, independent of its explanatory body.

// YAML mode expressions use block scalars because the commit prefix contains a colon.

// PR comments use explicit Pull requests write; Apple/EAS readbacks run independently of protocol completion.

// Apple readback JWT scope includes the exact fixed build filters and sparse fields; no native redispatch.

// Community release pin contains native-auth fix1668; production writers must complete before activation.
