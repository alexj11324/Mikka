import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { apiProxyOptions, developmentPages } from './dev-http.mjs'

const execute = promisify(execFile)
const repository = fileURLToPath(new URL('../../../', import.meta.url))

export function developmentOptions(args = [], env = process.env) {
  let port = env.PORT ?? env.MIKKA_DEV_PORT ?? '3000'
  let host = env.MIKKA_DEV_HOST ?? 'localhost'
  for (let index = 0; index < args.length; index++) {
    const [name, inline] = args[index].split('=', 2)
    if (!['--port', '-p', '--host', '--hostname', '-H'].includes(name)) throw new Error('API_DEV_ARGUMENT_INVALID')
    const value = inline ?? args[++index]
    if (!value || value.startsWith('-')) throw new Error('API_DEV_ARGUMENT_VALUE_REQUIRED')
    if (name === '--port' || name === '-p') port = value
    else host = value
  }
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('API_DEV_PORT_INVALID')
  if (!/^(?:[a-zA-Z0-9.-]+|::1|::)$/.test(host)) throw new Error('API_DEV_HOST_INVALID')
  const browserHost = ['0.0.0.0', '::'].includes(host) ? 'localhost' : host.includes(':') ? `[${host}]` : host
  return { port: Number(port), host, origin: `http://${browserHost}:${Number(port)}` }
}

export async function tracingEntry({ directory, originalEntry, tracing }) {
  if (typeof originalEntry !== 'string' || !originalEntry) throw new Error('API_DEV_RUNTIME_ENTRY_MISSING')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'tracing.mjs'), tracing)
  const entry = join(directory, 'entry.mjs')
  // Every Nitro worker, including hot replacements, loads tracing before its
  // dynamic application graph. A plugin runs too late for pg instrumentation.
  await writeFile(entry, `import "./tracing.mjs"\nconst application = await import(${JSON.stringify(originalEntry)})\nexport default application.default\n`)
  return entry
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
  await generate()
  let nitro, vite, closing
  const close = () => closing ??= (async () => {
    // Keep the public origin alive while the real Workflow close hook drains.
    // Nitro closes its own worker/watcher/listener; Vite owns its HMR sockets.
    try { await nitro?.close() } finally { await vite?.close() }
  })()
  try {
    nitro = await createNitro({
      rootDir: root, workspaceDir: root, dev: true, preset: 'nitro-dev', builder: 'rolldown',
      buildDir: join(directory, 'build'), output: { dir: join(directory, 'output') },
      routes: { '/**': join(root, 'apps/api/runtime/dev-entry.ts') },
      serveStatic: false,
      replace: { 'process.env.NEXT_PUBLIC_MIKKA_BUILD': '""' },
    }, { dotenv: false })
    // Config merging appends arrays; explicitly remove production public assets
    // so a clean development checkout needs no previous frontend build.
    nitro.options.publicAssets = []
    nitro.options.entry = await tracingEntry({ directory, originalEntry: nitro.options.entry, tracing: await compileTracing(root) })
    const api = createDevServer(nitro)
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
        proxy: apiProxyOptions(listener.url),
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
    const ready = await fetch(`${options.origin}/mikka/api/version`, { signal: AbortSignal.timeout(30_000) })
    if (!ready.ok) throw new Error('API_DEV_STARTUP_RESPONSE_INVALID')
    await ready.body?.cancel()
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
  const stop = () => stopping ??= Promise.resolve().then(() => development?.close()).finally(() => { process.exitCode = 0 })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop() })
  try {
    development = await startDevelopment({ args: process.argv.slice(2) })
    if (stopping) await development.close()
  } catch (error) {
    console.error('[dev] Startup failed', { name: error?.name ?? 'Error', code: error?.code ?? 'API_DEV_START_FAILED' })
    process.exitCode = 1
  }
}
