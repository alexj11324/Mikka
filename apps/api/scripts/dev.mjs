import { execFile } from 'node:child_process'
import { Agent } from 'node:http'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { apiProxyOptions, developmentPages } from './dev-http.mjs'
import { assertApiBuildConfiguration, nodeRuntimePackages } from '../build-contract.mjs'
import { startEveService } from '../../../scripts/eve-service.mjs'

const execute = promisify(execFile)
const repository = fileURLToPath(new URL('../../../', import.meta.url))

export function developmentOptions(args = [], env = process.env) {
  let port = env.PORT ?? env.MIKKA_DEV_PORT ?? '3000'
  let host = env.MIKKA_DEV_HOST ?? 'localhost'
  let allowStaleRoutes = false
  for (let index = 0; index < args.length; index++) {
    const [name, inline] = args[index].split('=', 2)
    // The stale-route guard's one escape hatch. Explicit, so it can be searched
    // for in a log and noticed in review, unlike editing the guard away.
    if (name === '--allow-stale-routes') { allowStaleRoutes = true; continue }
    if (!['--port', '-p', '--host', '--hostname', '-H'].includes(name)) throw new Error('API_DEV_ARGUMENT_INVALID')
    const value = inline ?? args[++index]
    if (!value || value.startsWith('-')) throw new Error('API_DEV_ARGUMENT_VALUE_REQUIRED')
    if (name === '--port' || name === '-p') port = value
    else host = value
  }
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('API_DEV_PORT_INVALID')
  if (!/^(?:[a-zA-Z0-9.-]+|::1|::)$/.test(host)) throw new Error('API_DEV_HOST_INVALID')
  const browserHost = ['0.0.0.0', '::'].includes(host) ? 'localhost' : host.includes(':') ? `[${host}]` : host
  return { port: Number(port), host, allowStaleRoutes, origin: `http://${browserHost}:${Number(port)}` }
}

export function configureDevelopmentWorker(nitro, tracing) {
  // Nitro keeps the old worker until its admitted HTTP exchanges finish.
  nitro.options.devServer.drain = true
  const config = nitro.options.rolldownConfig ?? {}
  nitro.options.rolldownConfig = {
    ...config,
    output: { ...config.output, entryFileNames: 'mikka-application.mjs' },
    plugins: [...config.plugins ?? [], {
      name: 'mikka-development-tracing',
      generateBundle() {
        // These final assets must not enter the application bundling graph:
        // Rolldown can hoist external pg imports ahead of an in-graph wrapper.
        // Every worker, including hot replacements, loads the finished entry.
        this.emitFile({ type: 'asset', fileName: 'mikka-tracing.mjs', source: tracing })
        this.emitFile({ type: 'asset', fileName: 'index.mjs', source:
          'import "./mikka-tracing.mjs"\nconst application = await import("./mikka-application.mjs")\nexport default application.default\n' })
      },
    }],
  }
}

const startupFailure = (code, cause) => Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code })

/** The generated files as the checkout holds them. A missing file is absent
 * from the map, which is how an untracked addition is told apart from a change. */
async function readGeneratedRoutes(root) {
  const held = new Map()
  for (const name of ['routes.json', 'routes.ts']) {
    const contents = await readFile(join(root, 'apps/api/generated', name), 'utf8').catch(() => undefined)
    if (contents !== undefined) held.set(name, contents)
  }
  return held
}

/** What the generator would write, versus what the checkout already holds.
 * The generator rewrites unconditionally, so a same-bytes rewrite leaves the
 * tree clean; only a real difference (or a file the checkout lacks) means the
 * route table would change under a developer who thinks they run committed code. */
export function staleRouteFiles(expected, actual) {
  const stale = []
  for (const [name, contents] of expected) {
    const path = `apps/api/generated/${name}`
    const held = actual.get(name)
    if (held === undefined || held !== contents) stale.push({ path, missing: held === undefined })
  }
  return stale
}

/** Refuse to serve a route table the checkout does not contain. A developer who
 * changed a route but not the generated files would otherwise run routes they
 * never reviewed and never committed, with nothing on screen saying so. */
export function staleRoutesRefusal(stale) {
  const added = stale.filter(entry => entry.missing).map(entry => entry.path)
  const changed = stale.filter(entry => !entry.missing).map(entry => entry.path)
  const lines = [`[dev] Route manifest is out of date: ${stale.map(entry => entry.path).join(', ')}`]
  if (changed.length) lines.push(`[dev] Changed: ${changed.join(', ')}`)
  if (added.length) lines.push(`[dev] Not in this checkout: ${added.join(', ')}`)
  lines.push('[dev] Serving now would run a route table you have not committed.',
    '[dev] Fix:', '  node apps/api/scripts/generate-routes.mjs',
    '  git add apps/api/generated && git commit',
    '[dev] Inspect only, without writing: node apps/api/scripts/generate-routes.mjs --check',
    '[dev] To run anyway (serves uncommitted routes): re-run with --allow-stale-routes')
  return Object.assign(new Error(lines.join('\n')), { code: 'API_DEV_ROUTES_STALE' })
}

function workerInitializationCause(raw, phase) {
  // env-runner 0.3.11 serializes Error.message, not its name/code. Preserve a
  // closed reason before the runner terminates; never retain that raw message,
  // which can contain a local path, application data, or a credential.
  const message = typeof raw === 'string' ? raw.slice(0, 1024) : ''
  let reason = 'unavailable', dependency = null
  const missing = /^Cannot find (?:package|module) '([^']+)'/.exec(message)
  if (missing) {
    reason = 'module-missing'
    if (nodeRuntimePackages.includes(missing[1])) dependency = missing[1]
    else for (const [file, label] of [['mikka-tracing.mjs', 'tracing-entry'], ['mikka-application.mjs', 'application-entry'], ['index.mjs', 'worker-entry']]) {
      if (missing[1].endsWith(`/${file}`)) { dependency = label; break }
    }
  } else if (/^The requested module .+ does not provide an export named /.test(message)
    || /^Named export .+ not found\./.test(message)) reason = 'export-missing'
  else if (/^(?:Unexpected (?:token|identifier|end of input)|Invalid or unexpected token)/.test(message)) reason = 'module-syntax'
  else if (message.startsWith('listen EADDRINUSE:')) reason = 'listen-address-in-use'
  else if (/^listen (?:EACCES|EPERM):/.test(message)) reason = 'listen-access-denied'
  else if (message.startsWith('listen EADDRNOTAVAIL:')) reason = 'listen-address-unavailable'
  else if (message.startsWith('listen ENAMETOOLONG:')) reason = 'listen-path-too-long'
  else if (message.startsWith('listen ENOENT:')) reason = 'listen-path-missing'
  else if (/^\[env-runner\] Entry module .+ must export a `fetch` handler/.test(message)) reason = 'entry-handler-missing'
  return { phase: ['initial-start', 'hot-replacement'].includes(phase) ? phase : 'unavailable', reason, dependency }
}

/** Subscribe before compilation. Nitro's dev:reload means the bundle exists;
 * only the runner's address message means its application has initialized. */
export function developmentWorkerReady(api, { phase = 'initial-start' } = {}) {
  const pending = Promise.withResolvers()
  void pending.promise.catch(() => {})
  let settled = false, signal
  const abort = () => finish(startupFailure('API_DEV_STARTUP_TIMEOUT'))
  const finish = error => {
    if (settled) return
    settled = true
    api.offMessage(message)
    signal?.removeEventListener('abort', abort)
    if (error) pending.reject(error)
    else pending.resolve()
  }
  const message = value => {
    if (value?.event === 'init-error') {
      const cause = workerInitializationCause(value.error, phase)
      // Node's TAP reporter omits Error.cause; emit the closed fields explicitly
      // while the same first refusal still rejects readiness immediately.
      console.error('[dev] Worker initialization failed', JSON.stringify(cause))
      finish(startupFailure('API_DEV_WORKER_INIT_FAILED', cause))
    }
    else if (value?.address && typeof value.address === 'object') finish()
  }
  api.onMessage(message)
  return {
    wait(deadline) {
      if (!settled) {
        signal = deadline
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      }
      return pending.promise
    },
    dispose() { finish(startupFailure('API_DEV_WORKER_CANCELLED')) },
  }
}

/** One deadline spans actual worker readiness and the original single HTTP
 * check. A starting worker's temporary 503 is never used as its ready signal. */
export async function developmentResponse(worker, origin, signal, read = fetch) {
  try {
    await worker.wait(signal)
    const response = await read(origin + '/mikka/api/version', { signal })
    if (!response.ok) throw startupFailure('API_DEV_STARTUP_RESPONSE_INVALID')
    await response.body?.cancel()
  } finally { worker.dispose() }
}

export async function closeDevelopment(development, log = console.error) {
  try { await development?.close(); return 0 }
  catch (error) {
    log('[dev] Shutdown failed', { name: error?.name ?? 'Error', code: 'API_DEV_SHUTDOWN_FAILED' })
    return 1
  }
}

export async function startDevelopment({ args = [], root = repository, log = console.info } = {}) {
  const started = performance.now()
  // Vite is the frontend workspace's declared dependency, not a second copy in
  // the backend. Resolve that exact installed package for its public Node API.
  const frontendRequire = createRequire(join(root, 'apps/frontend/package.json'))
  const { createServer, loadEnv } = await import(pathToFileURL(frontendRequire.resolve('vite')).href)
  if (process.env.MIKKA_DEV_SKIP_ENV_FILES !== '1') {
    for (const [key, value] of Object.entries(loadEnv('development', root, ''))) if (process.env[key] === undefined) process.env[key] = value
  }
  process.env.NODE_ENV = 'development'
  const options = developmentOptions(args)
  const directory = join(root, '.cache/dev-runtime', String(options.port))
  if (process.env.WORKFLOW_TARGET_WORLD && process.env.WORKFLOW_TARGET_WORLD !== 'local') throw new Error('API_DEV_LOCAL_WORLD_REQUIRED')
  process.env.WORKFLOW_TARGET_WORLD = 'local'
  process.env.WORKFLOW_LOCAL_BASE_URL ??= options.origin
  process.env.WORKFLOW_LOCAL_DATA_DIR ??= join(directory, 'workflow')
  process.env.BETTER_AUTH_URL ??= options.origin
  const [{ build, createDevServer, createNitro, prepare }, { compileTracing }, { frontendConfig }] = await Promise.all([
    import('nitro/builder'), import('./finalize-build.mjs'), import('../../frontend/vite.config.mjs'),
  ])
  const generate = () => execute(process.execPath, ['apps/api/scripts/generate-routes.mjs'], { cwd: root, maxBuffer: 1024 * 1024 })
  const { generateRoutes } = await import('./generate-routes.mjs')
  // Decide before writing. The generator rewrites unconditionally, so generating
  // first would repair the manifest and destroy the very evidence that this
  // checkout's route table differs from its sources. One scan, then write only
  // when the checkout may be served: a stale manifest cannot reach a server.
  const stale = staleRouteFiles((await generateRoutes(root)).files, await readGeneratedRoutes(root))
  if (stale.length) {
    if (!options.allowStaleRoutes) throw staleRoutesRefusal(stale)
    process.stderr.write(`[dev] WARNING: serving uncommitted routes (--allow-stale-routes): ${stale.map(entry => entry.path).join(', ')}\n`)
  }
  await generate()
  let nitro, vite, closing, workerReady, eve
  const proxyAgent = new Agent({ keepAlive: true, maxSockets: 256, maxTotalSockets: 256, maxFreeSockets: 64 })
  const close = () => closing ??= (async () => {
    // Keep the public origin alive while the real Workflow close hook drains.
    // Nitro closes its own worker/watcher/listener; Vite owns its HMR sockets.
    workerReady?.dispose()
    try { await nitro?.close() }
    finally {
      try { await vite?.close() }
      finally { proxyAgent.destroy(); await eve?.close() }
    }
  })()
  try {
    eve = await startEveService({ root, development: true })
    nitro = await createNitro({
      rootDir: root, workspaceDir: root, dev: true, preset: 'nitro-dev', builder: 'rolldown',
      buildDir: join(directory, 'build'), output: { dir: join(directory, 'output') },
      routes: { '/**': join(root, 'apps/api/runtime/dev-entry.ts') },
      serveStatic: false,
      replace: { 'process.env.NEXT_PUBLIC_MIKKA_BUILD': '""' },
    }, { dotenv: false })
    assertApiBuildConfiguration(nitro, root, { development: true })
    // Config merging appends arrays; explicitly remove production public assets
    // so a clean development checkout needs no previous frontend build.
    nitro.options.publicAssets = []
    configureDevelopmentWorker(nitro, await compileTracing(root))
    const api = createDevServer(nitro)
    workerReady = developmentWorkerReady(api)
    const compiled = Promise.withResolvers()
    // Attach rejection immediately: prepare/build can finish after a watch error.
    void compiled.promise.catch(() => {})
    nitro.hooks.hookOnce('dev:reload', () => compiled.resolve())
    nitro.hooks.hookOnce('dev:error', error => compiled.reject(error))
    const listener = api.listen({ port: 0, hostname: '127.0.0.1' })
    await listener.ready()
    const configuration = await frontendConfig({ target: 'web', command: 'serve' })
    vite = await createServer({
      ...configuration,
      appType: 'custom',
      plugins: [...configuration.plugins, developmentPages({ root, origin: process.env.BETTER_AUTH_URL ?? options.origin })],
      server: {
        ...configuration.server, host: options.host, port: options.port, strictPort: true,
        // Machine endpoints retain their own CORS/auth rules. Only the configured
        // preview hostname is added to Vite's existing loopback host allowance.
        cors: false,
        allowedHosts: configuration.server?.allowedHosts === true ? true : [
          ...configuration.server?.allowedHosts ?? [], new URL(process.env.BETTER_AUTH_URL).hostname,
        ],
        proxy: apiProxyOptions(listener.url, proxyAgent),
      },
    })
    // Normal source edits are handled by each compiler. A route declaration
    // change also refreshes the reviewed manifest, without evaluating handlers.
    let generating = Promise.resolve()
    const routeChanged = path => {
      if (!path.startsWith(join(root, 'app') + '/') || !/\/route\.(?:ts|tsx|mjs|js)$/.test(path)) return
      generating = generating.then(generate).catch(error => {
        log(`[dev] Route manifest could not refresh (${error?.code ?? error?.name ?? 'Error'})`)
      })
    }
    vite.watcher.add(join(root, 'app'))
    for (const event of ['add', 'change', 'unlink']) vite.watcher.on(event, routeChanged)
    await vite.listen()
    await prepare(nitro)
    await build(nitro)
    // build() installs a watcher. Wait for the first real graph and one existing
    // DB-free API through the public proxy before announcing readiness.
    await compiled.promise
    await developmentResponse(workerReady, options.origin, AbortSignal.timeout(30_000))
    log(`[dev] Local: ${options.origin}/mikka`)
    log(`[dev] Ready in ${Math.ceil(performance.now() - started)}ms (Vite + Nitro)`)
    return { ...options, nitro, vite, close }
  } catch (error) {
    await close()
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let development, stopping
  const stop = () => stopping ??= Promise.resolve().then(() => closeDevelopment(development)).then(code => {
    process.exitCode = Math.max(Number(process.exitCode) || 0, code)
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop() })
  try {
    development = await startDevelopment({ args: process.argv.slice(2) })
    if (stopping) await development.close()
  } catch (error) {
    // A stale route manifest is a condition the developer can fix, and the
    // refusal text is the whole value of stopping: print it as written rather
    // than folding it into the one-line diagnostic that hides its detail.
    if (error?.code === 'API_DEV_ROUTES_STALE') console.error(error.message)
    else console.error('[dev] Startup failed', { name: error?.name ?? 'Error', code: error?.code ?? 'API_DEV_START_FAILED' })
    process.exitCode = 1
  }
}
