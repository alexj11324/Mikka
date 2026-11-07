// Issue 1512 only: real, sequential HTTP/PG decomposition of the frozen Linux
// API. This is not a browser, Electron, OAuth-provider or macOS acceptance.
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const EXPECTED = Object.freeze({
  source: '3ad0fe25438887fe04f6dc6bda140f35d0bf4a03',
  candidate: '0d33e1bd7b170abe7cb0b8c9d1fef42bc951c920',
  tree: 'afe77de97310d38eb230d3ff0ee91f639ca5b8d1',
  parents: 'f811448d805e7baa7b032fd6ae62d991f59966c8 0d33e1bd7b170abe7cb0b8c9d1fef42bc951c920',
  artifactId: 13568227157, artifactRunId: 42357032863, artifactAttempt: 1,
  artifactBytes: 47856394,
  artifactSha256: 'd40b0a33843af21cd60d9ee9fe2bd049b40dead647a3f077d8d1e048ca6c130c',
})
const ORIGIN = 'http://localhost:3000'
const CACHE = 'x-mikka-session-cache'
const MAX_BODY = 8 * 1024 * 1024
const ZERO = { queryCalls: 0, pgProtocolReceiveBytes: 0, pgProtocolSendBytes: 0 }
class ProfileFailure extends Error {
  constructor(code) { super(code); this.name = 'ProfileFailure'; this.code = code }
}
const check = (condition, code) => { if (!condition) throw new ProfileFailure(code) }
const digest = value => createHash('sha256').update(value).digest('hex')
const failure = error => ({ name: ['ProfileFailure', 'TestAccountError', 'EnvironmentError', 'AbortError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
  code: error instanceof ProfileFailure ? error.code : 'DEPENDENCY_OR_RUNTIME_FAILED' })

export function options(args) {
  check(args.length === 6, 'ARGUMENTS_INVALID')
  const result = {}
  for (let i = 0; i < args.length; i += 2) {
    check(['--source', '--artifact-zip', '--output'].includes(args[i]) && !result[args[i]] && args[i + 1], 'ARGUMENTS_INVALID')
    result[args[i]] = resolve(args[i + 1])
  }
  return { source: result['--source'], zip: result['--artifact-zip'], output: result['--output'] }
}

async function availablePort(port) {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', () => reject(new ProfileFailure('API_PORT_NOT_FREE')))
    server.listen({ port, host: 'localhost', exclusive: true }, () => server.close(done))
  })
}

async function listenerClosed(callback) {
  const url = new URL(callback)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise((done, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(url.port) })
    socket.setTimeout(2000)
    socket.once('connect', () => { socket.destroy(); reject(new ProfileFailure('LOOPBACK_STILL_LISTENING')) })
    socket.once('timeout', () => { socket.destroy(); reject(new ProfileFailure('LOOPBACK_CLOSE_UNPROVEN')) })
    socket.once('error', error => error.code === 'ECONNREFUSED' ? done() : reject(new ProfileFailure('LOOPBACK_CLOSE_UNPROVEN')))
  })
}

export async function main(input) {
  const report = {
    version: 1, kind: 'issue1512_sequential_http_pg_decomposition', productionAcceptance: false,
    startedAt: new Date().toISOString(), status: 'running', source: { ...EXPECTED, verified: false, compiledVerified: false },
    runner: { runId: /^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') ? process.env.GITHUB_RUN_ID : null,
      attempt: /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '') ? Number(process.env.GITHUB_RUN_ATTEMPT) : null,
      operationRevision: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null,
      platform: process.platform, arch: process.arch, node: process.version },
    measurement: {
      source: 'existing desktop db-metrics.cjs and createLifecycleQueryCounter, one compiled primary API PID',
      scope: 'all pg.Client.query calls and connection protocol bytes between each pair of snapshots',
      exclusions: ['separate harness lease/fixture SQL', 'PG connection handshake and TCP/TLS overhead'],
      cache: 'ordinary Better Auth signed browser/native session cache; no clearing or invented proof',
      workspace: 'args:[], default selection, no workspace switch request or fabricated selector',
      interpretation: 'sequential decomposition only; not an exact allocation of the earlier concurrent Native minus Web query difference',
      background: 'all primary API background traffic is included; gaps are reported, never subtracted',
      protocol: 'ordinary leased email auth and real PKCE endpoints/owned loopback; no browser, provider challenge, daemon or VM',
      taskReads: 'two separate single requests; this does not replay or remove the Live channel catch-up',
      comparisons: 'desktop.session rows are additional action comparisons, not part of an observed login total',
    },
    phases: [], requests: [], gaps: [], cleanup: {},
  }
  let phase = 'preflight', privateDirectory, accountDirectory, scope, fixtures, api, setupChild, loopback, browserHttp, counter, runtime, bodyReader, clientVersion
  let createdContexts = 0, disposedContexts = 0
  let state, challenge, previous, passed = false, stopping = false, apiFailed = false
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  const cancelled = () => controller.abort()
  const timeout = setTimeout(cancelled, 8 * 60_000)
  const start = performance.now()
  const mark = name => { phase = name; report.phases.push({ name, elapsedMs: Math.round(performance.now() - start) }) }
  process.once('SIGINT', cancelled); process.once('SIGTERM', cancelled)
  let stopOwnedApplication

  async function runSetup(args, limitMs) {
    setupChild = spawn(process.execPath, args, { cwd: input.source, env: process.env, detached: true, stdio: 'ignore' })
    const owned = setupChild
    let timer
    const onAbort = () => rejectAbort(new ProfileFailure('SETUP_ABORTED'))
    let rejectAbort
    const aborted = new Promise((_, reject) => { rejectAbort = reject })
    controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const ended = new Promise((done, reject) => {
        owned.once('error', () => reject(new ProfileFailure('SETUP_START_FAILED')))
        owned.once('exit', (code, signal) => done({ code, signal }))
      })
      timer = setTimeout(() => rejectAbort(new ProfileFailure('SETUP_TIMEOUT')), limitMs)
      if (controller.signal.aborted) onAbort()
      const result = await Promise.race([ended, aborted])
      check(result.code === 0 && result.signal === null, 'SETUP_EXIT_FAILED')
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort)
      await stopOwnedApplication(owned)
      setupChild = undefined
    }
  }

  async function completeResponse(response) {
    const bytes = await bodyReader(response, MAX_BODY)
    return new Response([204, 205, 304].includes(response.status) ? null : bytes,
      { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  async function measured(id, route, action, purpose, work, expectedStatus = 200) {
    check(!controller.signal.aborted && !apiFailed && api?.exitCode === null && api?.signalCode === null, 'API_OR_BUDGET_UNAVAILABLE')
    mark(id)
    const before = await counter.snapshot()
    if (previous) {
      const gap = runtime.queryCountDelta(previous, before)
      report.gaps.push({ beforeRequest: id, ...gap })
    }
    const row = { id, route, action, purpose, status: 'running', httpStatus: null, before }
    report.requests.push(row)
    let response
    try {
      response = await completeResponse(await work())
      row.httpStatus = response.status
      check(response.status === expectedStatus, 'HTTP_STATUS_UNEXPECTED')
      row.status = 'http_complete'
      return { response, row }
    } catch (error) { row.status = 'failed'; row.failure = failure(error); throw error }
    finally {
      const after = await counter.snapshot()
      row.after = after
      row.delta = runtime.queryCountDelta(before, after)
      row.sameApiPid = before.pid === after.pid && after.pid === api.pid
      check(row.sameApiPid, 'COUNTER_PID_CHANGED')
      previous = after
    }
  }

  async function emailAuthentication(prefix) {
    const expected = ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/get-session']
    const rows = []
    // The original helper alone reads the generated password and maintains its
    // cookie jar/private storageState. This wrapper never examines request body
    // or headers. It only drains the ordinary response before the after-counter.
    globalThis.fetch = async (url, init) => {
      const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url)
      check(target.origin === ORIGIN && target.pathname === expected[rows.length] && !target.search && !target.hash,
        'AUTH_HELPER_REQUEST_CHANGED')
      check((init?.method ?? 'GET') === (rows.length === 0 ? 'POST' : 'GET'), 'AUTH_HELPER_REQUEST_CHANGED')
      const result = await measured(`${prefix}_${rows.length === 0 ? 'sign_in' : 'get_session'}`, target.pathname, null, 'ordinary_email_auth',
        () => originalFetch(url, { ...init, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) }))
      rows.push(result.row)
      return result.response
    }
    try {
      await scope.owner.reauthenticate()
      check(rows.length === 2, 'AUTH_HELPER_REQUEST_COUNT_CHANGED')
      for (const row of rows) { row.status = 'passed'; row.receipt = { originalLeaseIdentityValidated: true } }
    } finally { globalThis.fetch = originalFetch }
  }

  async function httpContext() {
    const localRequire = createRequire(join(input.source, 'package.json'))
    const { request } = localRequire('@playwright/test')
    // APIRequestContext is HTTP-only: no Chromium install/launch or browser.
    const context = await request.newContext({ baseURL: ORIGIN, storageState: scope.owner.storageStatePath, timeout: 15_000,
      extraHTTPHeaders: { origin: ORIGIN, 'accept-language': 'zh-CN', 'x-mikka-rpc': '1' } })
    createdContexts++
    return context
  }

  async function disposeHttp() {
    await browserHttp.dispose()
    disposedContexts++
    browserHttp = undefined
  }

  async function browserRequest(path, init = {}) {
    check(path.startsWith('/mikka/') && !path.startsWith('//') && !controller.signal.aborted, 'BROWSER_HTTP_TARGET_INVALID')
    await scope.assertActive()
    const value = await browserHttp.fetch(path, { ...init, maxRedirects: 0, maxRetries: 0, failOnStatusCode: false, timeout: 15_000 })
    try {
      const bytes = await value.body()
      check(bytes.length <= MAX_BODY, 'HTTP_BODY_TOO_LARGE')
      const headers = new Headers()
      for (const item of value.headersArray()) headers.append(item.name, item.value)
      return new Response([204, 205, 304].includes(value.status()) ? null : bytes, { status: value.status(), headers })
    } finally { await value.dispose() }
  }

  function direct(path, init = {}) {
    check(['/mikka/api/desktop/begin', '/mikka/api/desktop/exchange', '/mikka/api/desktop/rpc'].includes(path), 'NATIVE_HTTP_TARGET_INVALID')
    return originalFetch(new URL(path, ORIGIN), { ...init, redirect: 'manual', credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-mikka-client': 'desktop',
        'x-mikka-client-version': clientVersion, 'x-mikka-desktop-protocol': '1', 'x-mikka-locale': 'zh-CN', ...init.headers } })
  }

  function rpcPayload(action) { return { version: 1, action, args: [] } }
  function sessionMatches(value) {
    return value?.user?.id === scope.owner.userId && typeof value?.session?.id === 'string' && value.session.id.length > 0
  }
  async function rpcResult(result, action) {
    const body = await result.response.json()
    check(body?.version === 1 && body?.ok === true, 'RPC_ENVELOPE_INVALID')
    if (action === 'task-runs.pollTaskRuns') {
      check(Array.isArray(body.result?.items), 'TASK_LIST_INVALID')
      const fixtureTaskFound = body.result.items.some(item => item.runId === fixtures.fixture.run && item.issueId === fixtures.fixture.issue)
      check(fixtureTaskFound, 'FIXTURE_TASK_NOT_RETURNED')
      result.row.receipt = { fixtureTaskFound, itemCount: body.result.items.length }
    } else {
      check(sessionMatches(body.result), 'RPC_IDENTITY_MISMATCH')
      result.row.receipt = { sameLeasedOwner: true }
      if (action === 'desktop.bootstrap') {
        const match = body.result.cacheWorkspace?.workspaceId === fixtures.fixture.workspace
        result.row.receipt.cacheWorkspaceMatchesFixture = match
        check(match, 'DEFAULT_WORKSPACE_NOT_FIXTURE')
      }
    }
    result.row.status = 'passed'
    return body.result
  }

  try {
    check(process.platform === 'linux' && process.version === 'v24.22.1', 'RUNTIME_VERSION_MISMATCH')
    check(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
      && process.env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && process.env.GITHUB_REF === 'refs/heads/ops/1512-git-transport'
      && report.runner.runId && report.runner.attempt && report.runner.operationRevision,
    'OWNED_GITHUB_JOB_REQUIRED')
    check(!process.env.VERCEL && !process.env.VERCEL_ENV, 'DEPLOYED_ENVIRONMENT_FORBIDDEN')
    check(!['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
      'AI_GATEWAY_API_KEY', 'DEEPSEEK_API_KEY', 'E2B_API_KEY', 'COMPOSIO_API_KEY', 'POSTHOG_SECRET_KEY', 'NEXT_PUBLIC_POSTHOG_KEY',
      'RESEND_API_KEY', 'ZEROCAT_API_KEY', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_SECRET'].some(key => process.env[key]), 'EXTERNAL_CREDENTIAL_FORBIDDEN')
    input.source = await realpath(input.source)
    const git = args => execFileSync('git', args, { cwd: input.source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    check(git(['rev-parse', 'HEAD']) === EXPECTED.source && git(['rev-parse', 'HEAD^{tree}']) === EXPECTED.tree
      && git(['show', '-s', '--format=%P', 'HEAD']) === EXPECTED.parents && !git(['status', '--porcelain', '--untracked-files=no']), 'SOURCE_IDENTITY_MISMATCH')
    const zip = await lstat(input.zip)
    check(zip.isFile() && !zip.isSymbolicLink() && zip.size === EXPECTED.artifactBytes, 'ARTIFACT_BYTES_MISMATCH')
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(input.zip)) hash.update(bytes)
    check(hash.digest('hex') === EXPECTED.artifactSha256, 'ARTIFACT_DIGEST_MISMATCH')
    report.source.verified = true
    const database = new URL(process.env.E2E_DATABASE_URL ?? 'invalid:')
    check(['postgres:', 'postgresql:'].includes(database.protocol) && database.hostname === '127.0.0.1' && database.port === '5432'
      && database.pathname === '/mikka_e2e' && database.username === 'e2e' && !database.search && !database.hash, 'FRESH_LOOPBACK_DATABASE_REQUIRED')
    for (const name of ['DATABASE_URL', 'MIKKA_DATABASE_URL', 'ORVILO_DATABASE_URL']) {
      check(!process.env[name] || process.env[name] === database.href, 'DATABASE_TARGET_MISMATCH')
    }
    privateDirectory = await mkdtemp(join(tmpdir(), 'mikka-i1512-query-'))
    process.chdir(input.source)
    Object.assign(process.env, {
      DATABASE_URL: database.href, MIKKA_DATABASE_URL: database.href, E2E_DATABASE_URL: database.href,
      BETTER_AUTH_URL: ORIGIN, E2E_BASE_URL: ORIGIN, AUTH_TRUSTED_ORIGINS: ORIGIN,
      BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'),
      MIKKA_LOCAL_TEST_ACCOUNTS: '1', MIKKA_TEST_DEPLOYMENT_SHA: EXPECTED.source,
      MIKKA_TEST_ENVIRONMENT_FILE: join(privateDirectory, 'environment.json'),
      MIKKA_DEV_SKIP_ENV_FILES: '1', NEXT_TELEMETRY_DISABLED: '1', MIKKA_TRACE_SAMPLE_RATE: '0', NODE_OPTIONS: '',
    })
    const fromSource = path => import(pathToFileURL(join(input.source, path)).href)
    const application = await fromSource('apps/desktop/test/production-application.mjs')
    stopOwnedApplication = application.stopOwnedApplication
    runtime = await fromSource('apps/desktop/test/lifecycle-query-counts.mjs')
    bodyReader = (await fromSource('scripts/test-accounts/http-body.mjs')).readBoundedBody
    const compiled = await application.productionApplication(input.source, { expectedRevision: EXPECTED.source, hostname: 'localhost', port: 3000,
      preload: join(input.source, 'apps/desktop/test/db-metrics.cjs') })
    check(compiled.kind === 'nitro', 'EXPECTED_NITRO_ARTIFACT')
    report.source.compiledVerified = true
    const packageJson = JSON.parse(await readFile(join(input.source, 'package.json'), 'utf8'))
    check(packageJson.packageManager === 'pnpm@10.34.3', 'PACKAGE_MANAGER_MISMATCH')
    clientVersion = JSON.parse(await readFile(join(input.source, 'apps/desktop/package.json'), 'utf8')).version
    check(typeof clientVersion === 'string' && /^\d+\.\d+\.\d+$/.test(clientVersion), 'CLIENT_VERSION_INVALID')
    report.source.clientVersion = clientVersion
    await availablePort(3000)

    mark('schema_setup')
    await runSetup(['--import', 'tsx', 'scripts/setup-e2e-db.mjs'], 180_000)
    mark('environment_bootstrap')
    await runSetup(['scripts/test-accounts/bootstrap.mjs', '--output', process.env.MIKKA_TEST_ENVIRONMENT_FILE], 30_000)
    const environment = await (await fromSource('scripts/test-accounts/environment.mjs')).loadEnvironment()
    check(/^[a-f0-9-]{36}$/.test(environment.instanceId), 'ACCOUNT_DIRECTORY_BINDING_INVALID')
    accountDirectory = join(input.source, '.cache/e2e/test-accounts', environment.instanceId)
    mark('api_start')
    const socket = `/tmp/mikka-bundled-${process.pid}.sock`
    const socketAbsent = await lstat(socket).then(() => false, error => {
      if (error.code === 'ENOENT') return true
      throw error
    })
    check(socketAbsent, 'METRICS_SOCKET_ALREADY_EXISTS')
    const childEnv = { ...application.productionEnvironment(process.env, { origin: ORIGIN, port: 3000 }), MIKKA_DESKTOP_METRICS_SOCKET: socket }
    api = spawn(process.execPath, compiled.args, { cwd: input.source, env: childEnv, detached: true, stdio: 'ignore' })
    api.once('error', () => { apiFailed = true })
    api.once('exit', () => { if (!stopping) apiFailed = true })
    const readyBy = performance.now() + 60_000
    let ready = false
    while (performance.now() < readyBy && !controller.signal.aborted && !apiFailed) {
      try {
        const response = await originalFetch(`${ORIGIN}/mikka/api/version`, { redirect: 'manual', signal: AbortSignal.timeout(1500) })
        const value = response.ok ? await response.json() : null
        if (value?.build === compiled.appBuild) { ready = true; break }
        await response.body?.cancel()
      } catch { /* Existing bounded startup readiness only; no business polling. */ }
      await delay(250, undefined, { signal: controller.signal })
    }
    check(ready && !apiFailed, 'API_READINESS_FAILED')
    const runtimePath = join(privateDirectory, 'processes.json')
    await writeFile(runtimePath, JSON.stringify({ revision: EXPECTED.source, origin: ORIGIN,
      bundled: { pid: api.pid, port: 3000, socket, runtime: compiled.kind } }), { mode: 0o600, flag: 'wx' })
    counter = await runtime.createLifecycleQueryCounter({ revision: EXPECTED.source, origin: ORIGIN, runtimePath })
    report.counter = { ...counter.source, process: 'single compiled primary API for this sequential HTTP diagnostic' }

    mark('lease_and_fixture')
    const sessions = await fromSource('scripts/test-accounts/session.mjs')
    scope = await sessions.acquireTestAccounts({ runId: `issue1512-query-${report.runner.runId}`, workerId: 'sequential-http',
      requestId: randomUUID(), ttlMs: 300_000 })
    fixtures = await (await fromSource('apps/desktop/test/parity-fixtures.mjs')).createParityFixtures(scope, { includePeerCoordinator: true })
    report.fixture = { originalParityFixture: true, endedTask: true, disabledDevice: true, explicitWorkspaceSelector: false }
    await emailAuthentication('web')
    browserHttp = await httpContext()
    for (const action of ['desktop.bootstrap', 'desktop.session']) {
      await rpcResult(await measured(`web_${action.split('.')[1]}`, '/mikka/api/rpc', action,
        action === 'desktop.session' ? 'additional_action_comparison' : 'web_workspace_read',
        () => browserRequest('/mikka/api/rpc', { method: 'POST', data: rpcPayload(action) })), action)
    }
    await disposeHttp()

    // The real lifecycle closes Web before reauthentication creates the final
    // browser session retained by native PKCE. Never reuse a revoked bearer.
    await emailAuthentication('native')
    browserHttp = await httpContext()
    state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    challenge = createHash('sha256').update(verifier).digest('base64url')
    const localRequire = createRequire(join(input.source, 'package.json'))
    const { tsImport } = localRequire('tsx/esm/api')
    const { startBundledLoopback } = await tsImport('./apps/desktop/src/main/bundled-loopback.ts', {
      parentURL: pathToFileURL(join(input.source, 'package.json')).href, tsconfig: join(input.source, 'tsconfig.json'),
    })
    let receivedCode
    loopback = await startBundledLoopback(state, code => { receivedCode = code })
    const begun = await measured('pkce_begin', '/mikka/api/desktop/begin', null, 'native_pkce',
      () => direct('/mikka/api/desktop/begin', { method: 'POST', body: JSON.stringify({ state, callback: loopback.callback, challenge }) }), 204)
    begun.row.status = 'passed'
    const confirmation = await rpcResult(await measured('system_browser_bootstrap', '/mikka/api/rpc', 'desktop.bootstrap', 'system_browser_confirmation_read',
      () => browserRequest('/mikka/api/rpc', { method: 'POST', data: rpcPayload('desktop.bootstrap') })), 'desktop.bootstrap')
    const returned = await measured('pkce_return', '/mikka/api/desktop/return', null, 'native_pkce',
      () => browserRequest(`/mikka/api/desktop/return?${new URLSearchParams({ state, callback: loopback.callback, next: '/' })}`), 303)
    const location = new URL(returned.response.headers.get('location'))
    const callback = new URL(loopback.callback)
    check(location.origin === callback.origin && location.pathname === callback.pathname && !location.username && !location.password
      && !location.hash && location.searchParams.getAll('state').length === 1 && location.searchParams.get('state') === state
      && location.searchParams.getAll('code').length === 1 && /^[A-Za-z0-9_-]{32,128}$/.test(location.searchParams.get('code') ?? ''), 'PKCE_RETURN_INVALID')
    returned.row.status = 'passed'; returned.row.receipt = { exactOwnedLoopback: true }
    // Follow only this verified owned listener, without browser cookies or bearer.
    const callbackResponse = await originalFetch(location, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000) })
    check(callbackResponse.ok, 'PKCE_LOOPBACK_REJECTED')
    await bodyReader(callbackResponse, 16_384)
    check(receivedCode === location.searchParams.get('code'), 'PKCE_LOOPBACK_CODE_MISMATCH')
    const exchanged = await measured('pkce_exchange', '/mikka/api/desktop/exchange', null, 'native_pkce',
      () => direct('/mikka/api/desktop/exchange', { method: 'POST', body: JSON.stringify({ state, code: receivedCode, verifier, client: 'bundled' }) }))
    const native = await exchanged.response.json()
    check(sessionMatches(native) && native.session.id === confirmation.session.id
      && /^[A-Za-z0-9_.%~+/-]{32,512}$/.test(native.token ?? ''), 'PKCE_IDENTITY_MISMATCH')
    let cache = exchanged.response.headers.get(CACHE) ?? undefined
    check(cache === undefined || /^[A-Za-z0-9_-]{1,16384}$/.test(cache), 'NATIVE_CACHE_INVALID')
    await scope.recordResource({ type: 'session', id: native.session.id, ownerId: scope.owner.userId })
    exchanged.row.status = 'passed'; exchanged.row.receipt = { sameLeasedOwner: true, sameBrowserSession: true, signedCachePresent: Boolean(cache) }
    await disposeHttp()
    for (const [id, action, purpose] of [
      ['native_bootstrap', 'desktop.bootstrap', 'native_workspace_read'],
      ['native_session', 'desktop.session', 'additional_action_comparison'],
      ['native_task_runs_first', 'task-runs.pollTaskRuns', 'native_single_task_read'],
      ['native_task_runs_second', 'task-runs.pollTaskRuns', 'native_single_task_read'],
    ]) {
      const carriedCache = Boolean(cache)
      const result = await measured(id, '/mikka/api/desktop/rpc', action, purpose, () => direct('/mikka/api/desktop/rpc', {
        method: 'POST', body: JSON.stringify(rpcPayload(action)), headers: { authorization: `Bearer ${native.token}`, ...(cache ? { [CACHE]: cache } : {}) },
      }))
      const nextCache = result.response.headers.get(CACHE)
      check(nextCache === null || nextCache === '' || /^[A-Za-z0-9_-]{1,16384}$/.test(nextCache), 'NATIVE_CACHE_INVALID')
      if (nextCache !== null) cache = nextCache || undefined
      await rpcResult(result, action)
      result.row.receipt.carriedNormalSignedCache = carriedCache
    }
    passed = report.requests.length === 14 && report.requests.every(row => row.status === 'passed')
    check(passed, 'REQUEST_PLAN_INCOMPLETE')
    report.gaps.push({ beforeRequest: 'cleanup', ...runtime.queryCountDelta(previous, await counter.snapshot()) })
  } catch (error) {
    report.failure = { phase, ...failure(error) }
  } finally {
    globalThis.fetch = originalFetch
    clearTimeout(timeout)
    const clean = async (name, work) => {
      try { const value = await work(); report.cleanup[name] = { status: 'passed', ...value } }
      catch (error) { report.cleanup[name] = { status: 'failed', ...failure(error) }; passed = false }
    }
    await clean('http_context', async () => {
      if (browserHttp) await disposeHttp()
      check(createdContexts === disposedContexts, 'HTTP_CONTEXT_CLOSE_UNPROVEN')
      return { created: createdContexts, disposed: disposedContexts }
    })
    if (loopback) await clean('owned_loopback', async () => { loopback.close(); await listenerClosed(loopback.callback) })
    // Only this generated nonce, challenge, callback and leased owner may be
    // removed, including an unbound begin row if the later request failed.
    if (scope && state && loopback) await clean('owned_pkce', () => scope.pool.transaction(async client => {
      await scope.pool.current(client, scope.lease)
      const hash = digest(state)
      const removed = await client.query('DELETE FROM desktop_auth_requests WHERE "stateHash"=$1 AND callback=$2 AND "codeChallenge"=$3 AND ("userId" IS NULL OR "userId"=$4)',
        [hash, loopback.callback, challenge, scope.owner.userId])
      check(removed.rowCount >= 0 && removed.rowCount <= 1, 'PKCE_CLEANUP_COUNT_INVALID')
      const remaining = await client.query('SELECT 1 FROM desktop_auth_requests WHERE "stateHash"=$1', [hash])
      check(remaining.rowCount === 0, 'PKCE_CLEANUP_UNPROVEN')
      await scope.pool.current(client, scope.lease)
      return { removedRows: removed.rowCount }
    }))
    if (fixtures) await clean('fixtures', () => fixtures.cleanup())
    if (scope) await clean('lease', async () => {
      const released = await scope.release({ outcome: passed ? 'clean' : 'dirty' })
      check(released.state === (passed ? 'released' : 'quarantined'), 'LEASE_RELEASE_UNPROVEN')
      return { state: released.state }
    })
    stopping = true
    if (setupChild) await clean('setup_process', () => stopOwnedApplication(setupChild))
    if (api) await clean('api_process', async () => {
      await stopOwnedApplication(api)
      check(api.exitCode !== null || api.signalCode !== null, 'API_EXIT_UNPROVEN')
      return { exited: true, forcedKill: false }
    })
    if (accountDirectory) await clean('private_account_files', () => rm(accountDirectory, { recursive: true, force: true }))
    if (privateDirectory) await clean('private_runtime_files', () => rm(privateDirectory, { recursive: true, force: true }))
    if (api) await clean('owned_metrics_socket', () => rm(`/tmp/mikka-bundled-${process.pid}.sock`, { force: true }))
    report.status = passed && !report.failure ? 'passed' : 'failed'
    report.finishedAt = new Date().toISOString()
    report.elapsedMs = Math.round(performance.now() - start)
    report.summary = {
      completedRequests: report.requests.filter(row => row.status === 'passed').length,
      comparisonRequests: report.requests.filter(row => row.purpose === 'additional_action_comparison').length,
      sameApiPid: report.requests.length > 0 && report.requests.every(row => row.sameApiPid),
      unmeasuredGaps: report.gaps.reduce((total, gap) => Object.fromEntries(Object.keys(ZERO).map(key => [key, total[key] + gap[key]])), { ...ZERO }),
      cleanupComplete: Object.values(report.cleanup).every(value => value.status === 'passed'),
    }
    await mkdir(dirname(input.output), { recursive: true, mode: 0o700 })
    const json = JSON.stringify(report, null, 2) + '\n'
    check(Buffer.byteLength(json) < 256 * 1024, 'SAFE_REPORT_TOO_LARGE')
    await writeFile(input.output, json, { mode: 0o600, flag: 'wx' })
    process.removeListener('SIGINT', cancelled); process.removeListener('SIGTERM', cancelled)
  }
  console.log(JSON.stringify({ type: report.kind, status: report.status, completedRequests: report.summary.completedRequests,
    cleanupComplete: report.summary.cleanupComplete, ...(report.failure ? { failure: report.failure } : {}) }))
  if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => options(process.argv.slice(2))).then(main).catch(error => {
    console.error(JSON.stringify({ status: 'failed', ...failure(error) }))
    process.exitCode = 1
  })
}
