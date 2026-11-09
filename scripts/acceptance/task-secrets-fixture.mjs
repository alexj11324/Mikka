import { randomBytes, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw Error(code) }

/** Source-only build: no network, account or provider call. Include the actual
 * application data plane and daemon compatibility bridge without a test fork. */
export async function buildFixtureBundles(buildImpl) {
  const build = buildImpl ?? (await import('esbuild')).build
  const bundle = async entry => {
    const result = await build({ absWorkingDir: ROOT, entryPoints: [entry], bundle: true,
      platform: 'node', format: 'esm', target: 'node22', write: false, metafile: true,
      // The ordinary SDK has bundled CommonJS dependencies that require Node
      // built-ins. Keep that standard Node loader available in the ESM file.
      banner: { js: "import { createRequire as __mikkaCreateRequire } from 'node:module'; const require = __mikkaCreateRequire(import.meta.url);" },
      logLevel: 'silent', sourcemap: false })
    const inputs = Object.keys(result.metafile.inputs)
    check(!inputs.some(path => /(?:^|\/)(?:lib\/db|lib\/auth|pg|postgres|drizzle-orm)(?:\/|\.)/.test(path)), 'fixture_control_plane_import')
    const source = result.outputFiles[0].text
    return { source, sha256: hash(source), bytes: Buffer.byteLength(source), inputCount: inputs.length }
  }
  const [server, client] = await Promise.all([
    bundle('scripts/acceptance/task-secrets-fixture-runtime.mjs'),
    bundle('scripts/acceptance/task-secrets-native.mjs'),
  ])
  return { server, client }
}

/** Existing CI E2B identity only; never enroll this fixture with Mikka, install
 * native model credentials, snapshot it, publish it or alter a template. */
export async function createIsolatedFixture({ fixtureId, sourceCommit, apiKey, bundles, driver }, {
  sandboxFactory, fetchImpl = fetch, now = Date.now, onEvidence = () => {}, onCreated = async () => {}, signal, cleanupSignal = () => undefined,
} = {}) {
  check(UUID.test(fixtureId ?? '') && /^[a-f0-9]{40}$/.test(sourceCommit ?? '') && typeof apiKey === 'string' && apiKey.length > 0, 'fixture_configuration')
  if (!sandboxFactory) {
    const { Sandbox } = await import('e2b')
    sandboxFactory = (template, options) => Sandbox.create(template, options)
  }
  if (driver) check(Number.isSafeInteger(driver.runId) && driver.runId > 0
    && Number.isSafeInteger(driver.runAttempt) && driver.runAttempt > 0, 'fixture_configuration')
  const metadata = { application: 'mikka-1712-secret-fixture', acceptance: fixtureId, sourceCommit,
    ...(driver ? { driverRunId: String(driver.runId), driverRunAttempt: String(driver.runAttempt) } : {}) }
  const startedAt = new Date(now()).toISOString()
  const sandbox = await sandboxFactory('codex', { apiKey, timeoutMs: 20 * 60_000, requestTimeoutMs: 60_000, metadata, signal })
  const upstreamOrigin = `https://${sandbox.getHost(8080)}`, fixtureOrigin = `https://${sandbox.getHost(8081)}`
  const controlToken = randomBytes(32).toString('hex')
  const evidence = { kind: 'official_codex_disposable_fixture', fixtureId, sandboxIdHash: hash(sandbox.sandboxId).slice(0, 16),
    sourceCommit, startedAt, maximumLifetimeMs: 20 * 60_000,
    clientBundleSha256: bundles.client.sha256, serverBundleSha256: bundles.server.sha256,
    productionStoreMutated: false, signingKeySource: 'independent_random_per_case', noDatabaseImports: true,
    cleanup: { stopped: false, outcome: 'not_yet_attempted' } }
  let closed = false
  const control = async (value, timeoutMs = 25_000) => {
    check(!closed, 'fixture_closed')
    const response = await fetchImpl(`${fixtureOrigin}/control`, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(value), signal: AbortSignal.timeout(timeoutMs) })
    check(response.ok, 'fixture_control_refused')
    return response.json()
  }
  const close = async () => {
    if (closed) return evidence.cleanup
    evidence.cleanup = { stopped: false, outcome: 'unconfirmed', requestedAt: new Date(now()).toISOString() }
    let persistenceFailure
    try { await onEvidence(evidence) } catch (cause) { persistenceFailure = cause }
    const cleanupOptions = { requestTimeoutMs: 20_000, signal: cleanupSignal() }
    const info = await sandbox.getInfo(cleanupOptions)
    check(info.sandboxId === sandbox.sandboxId && Object.entries(metadata).every(([key, value]) => info.metadata?.[key] === value), 'fixture_cleanup_scope')
    check(await sandbox.kill(cleanupOptions) !== false, 'fixture_cleanup_failed')
    closed = true
    evidence.cleanup = { stopped: true, ownershipVerified: true, outcome: 'provider_kill_acknowledged', stoppedAt: new Date(now()).toISOString() }
    await onEvidence(evidence)
    if (persistenceFailure) throw Error('fixture_journal_failed', { cause: persistenceFailure })
    return evidence.cleanup
  }
  try {
    await onCreated({ sandboxId: sandbox.sandboxId, metadata, startedAt })
    await onEvidence(evidence)
    await sandbox.commands.run('install -d -m 700 /run/mikka-1712-fixture', { user: 'root', timeoutMs: 10_000, requestTimeoutMs: 15_000, signal })
    const uploadOptions = { user: 'root', requestTimeoutMs: 15_000, signal }
    await sandbox.files.write('/run/mikka-1712-fixture/server.mjs', bundles.server.source, uploadOptions)
    await sandbox.files.write('/run/mikka-1712-fixture/client.mjs', bundles.client.source, uploadOptions)
    await sandbox.files.write('/run/mikka-1712-fixture/config.json', JSON.stringify({ fixtureId, controlToken, upstreamOrigin, egressOrigin: fixtureOrigin }), uploadOptions)
    let ready, refused, output = ''
    const pending = new Promise((resolve, reject) => { ready = resolve; refused = reject })
    // Cancellation can arrive while the start request is still pending; the
    // original promise is awaited below after that request settles.
    void pending.catch(() => {})
    const aborted = () => refused(Error('fixture_execution_aborted'))
    if (signal?.aborted) aborted(); else signal?.addEventListener('abort', aborted, { once: true })
    const timer = setTimeout(() => refused(Error('fixture_ready_timeout')), 30_000)
    try {
      const process = await sandbox.commands.run('exec node /run/mikka-1712-fixture/server.mjs /run/mikka-1712-fixture/config.json /run/mikka-1712-fixture/client.mjs', {
        user: 'root', background: true, timeoutMs: 0, requestTimeoutMs: 15_000, signal, onStdout: chunk => {
          output += chunk
          if (output.length > 1024) { refused(Error('fixture_output_invalid')); return }
          if (output.includes('MIKKA_1712_FIXTURE_READY\n')) ready()
        }, onStderr: () => {},
      })
      void process.wait().then(() => refused(Error('fixture_exited')), cause => refused(Error('fixture_process_failed', { cause })))
      await pending
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', aborted) }
    const response = await fetchImpl(`${fixtureOrigin}/health`, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
    const health = await response.json()
    check(response.ok && health.ready === true && health.fixtureId === fixtureId, 'fixture_health')
    return { fixtureOrigin, upstreamOrigin,
      evidence,
      createCase: async caseId => {
        const bootstrapToken = randomBytes(32).toString('hex')
        const value = await control({ action: 'create', caseId, bootstrapToken })
        check(value.caseId === caseId && /^[a-f0-9]{64}$/.test(value.canarySha256 ?? '')
          && /^[a-f0-9]{64}$/.test(value.responseSha256 ?? ''), 'fixture_case_invalid')
        return { caseId, bootstrapToken, canarySha256: value.canarySha256, responseSha256: value.responseSha256 }
      },
      createProductionCase: async (caseId, canary) => {
        check(UUID.test(caseId ?? '') && /^mikka1712s_[a-f0-9]{64}$/.test(canary ?? ''), 'fixture_case_invalid')
        const value = await control({ action: 'create_production', caseId, canary })
        check(value.caseId === caseId && value.canarySha256 === hash(canary)
          && /^[a-f0-9]{64}$/.test(value.responseSha256 ?? '') && /^[a-f0-9]{64}$/.test(value.sdkResponseSha256 ?? ''), 'fixture_case_invalid')
        return { caseId, canarySha256: value.canarySha256, responseSha256: value.responseSha256, sdkResponseSha256: value.sdkResponseSha256 }
      },
      waitForProtected: async caseId => {
        const value = await control({ action: 'wait_protected', caseId }, 245_000)
        check(value.caseId === caseId && UUID.test(value.runId ?? '') && Number.isSafeInteger(value.protectedRequests)
          && value.protectedRequests >= 1 && value.protectedRequests <= 100, 'fixture_receipt')
        return { caseId, runId: value.runId, protectedRequests: value.protectedRequests }
      },
      bind: async (caseId, runId) => check((await control({ action: 'bind', caseId, runId })).bound === true, 'fixture_bind'),
      receipt: async caseId => {
        const value = await control({ action: 'receipt', caseId })
        check(value.caseId === caseId && UUID.test(value.runId ?? '') && typeof value.issued === 'boolean'
          && typeof value.rotated === 'boolean' && ['public', 'protected', 'echo', 'redirect'].every(name =>
            Number.isSafeInteger(value.counts?.[name]) && value.counts[name] >= 0 && value.counts[name] <= 100), 'fixture_receipt')
        check(value.mode !== 'production_claim' || Number.isSafeInteger(value.counts.sdk) && value.counts.sdk >= 0 && value.counts.sdk <= 100, 'fixture_receipt')
        return { caseId, runId: value.runId, issued: value.issued, rotated: value.rotated,
          ...(value.mode === 'production_claim' ? { mode: value.mode } : {}),
          counts: Object.fromEntries(['public', 'protected', 'echo', 'redirect', ...(value.mode === 'production_claim' ? ['sdk'] : [])].map(name => [name, value.counts[name]])) }
      },
      deleteCase: async caseId => check((await control({ action: 'delete', caseId })).deleted === true, 'fixture_delete'),
      close,
    }
  } catch (cause) {
    try { await close() } catch { /* The caller receives an explicit failed setup; TTL still bounds this owned VM. */ }
    throw Error('fixture_setup_failed', { cause })
  }
}

/** Cancellation recovery never connects/resumes a VM. Exact invocation
 * metadata can resolve a lost create reply; ambiguous or partial listings
 * remain unconfirmed. A kill reply is followed by an actual absence read.
 */
export async function cleanupIsolatedFixture(target, apiKey, { provider, signal, now = Date.now } = {}) {
  const metadata = target?.metadata
  check(metadata?.application === 'mikka-1712-secret-fixture' && UUID.test(metadata.acceptance ?? '')
    && /^[a-f0-9]{40}$/.test(metadata.sourceCommit ?? '')
    && ['driverRunId', 'driverRunAttempt'].every(key => /^[1-9][0-9]*$/.test(metadata[key] ?? ''))
    && typeof apiKey === 'string' && apiKey.length > 0
    && (!target.sandboxId || /^[A-Za-z0-9_-]{1,128}$/.test(target.sandboxId)), 'fixture_cleanup_scope')
  if (!provider) {
    const { Sandbox, SandboxNotFoundError } = await import('e2b')
    provider = { getInfo: (id, options) => Sandbox.getInfo(id, options), kill: (id, options) => Sandbox.kill(id, options),
      list: options => Sandbox.list(options), missing: cause => cause instanceof SandboxNotFoundError }
  }
  const options = { apiKey, requestTimeoutMs: 20_000, signal }
  let id = target.sandboxId
  if (!id) {
    const listing = provider.list({ apiKey, requestTimeoutMs: 20_000, query: { metadata }, limit: 2 })
    const rows = await listing.nextItems(options)
    check(!listing.hasNext && rows.length <= 1, 'fixture_cleanup_scope')
    if (!rows.length) return { stopped: false, outcome: 'creation_unconfirmed', observedAt: new Date(now()).toISOString() }
    id = rows[0].sandboxId
    check(/^[A-Za-z0-9_-]{1,128}$/.test(id ?? ''), 'fixture_cleanup_scope')
  }
  let info
  try { info = await provider.getInfo(id, options) }
  catch (cause) {
    if (!provider.missing(cause)) throw Error('fixture_cleanup_unconfirmed', { cause })
    return { stopped: true, sandboxId: id, outcome: 'provider_absence_verified', observedAt: new Date(now()).toISOString() }
  }
  check(info.sandboxId === id && Object.entries(metadata).every(([key, value]) => info.metadata?.[key] === value), 'fixture_cleanup_scope')
  await provider.kill(id, options)
  try { await provider.getInfo(id, options) }
  catch (cause) {
    if (!provider.missing(cause)) throw Error('fixture_cleanup_unconfirmed', { cause })
    return { stopped: true, sandboxId: id, ownershipVerified: true, outcome: 'provider_kill_and_absence_verified', observedAt: new Date(now()).toISOString() }
  }
  throw Error('fixture_cleanup_unconfirmed')
}
