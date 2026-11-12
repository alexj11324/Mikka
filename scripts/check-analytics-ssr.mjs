// The historical check name is retained. A SPA must execute its real browser
// entry: a successful HTML shell cannot prove that React or analytics mounted.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { load as loadYaml } from 'js-yaml'
import { POSTER_BINARY_ARCHIVE, POSTER_BINARY_MANIFEST, POSTER_BINARY_MAX_BYTES,
  POSTER_LICENSE_FILES, POSTER_RUNTIME_DIRECTORY } from '../lib/captures/poster-binary.mjs'
import { readCompiledBuild } from './start-app.mjs'

export const analyticsKey = 'phc_synthetic_ssr_regression'
export const analyticsPaths = ['/mikka', '/mikka/sign-in', '/mikka/en/sign-in']
export const requiredRuntimeResources = [
  'packages/daemon/scripts/official-e2b-instance-bootstrap.sh',
  'packages/daemon/scripts/refresh-cloud-worker.py',
  'scripts/e2b/inspect-retained-deliverable.mjs',
]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const decompress = promisify(gunzip)
const posterResources = new Set([POSTER_BINARY_ARCHIVE, POSTER_BINARY_MANIFEST,
  ...POSTER_LICENSE_FILES.map(name => `${POSTER_RUNTIME_DIRECTORY}/${name}`)])

export function analyticsEnvironment(env = process.env) {
  assert.equal(env.CI, 'true', 'Requires an isolated CI environment')
  assert.equal(env.NEXT_PUBLIC_POSTHOG_KEY, analyticsKey, 'Only the synthetic analytics project is allowed')
  const database = new URL(env.E2E_DATABASE_URL)
  assert.ok(['postgres:', 'postgresql:'].includes(database.protocol))
  assert.ok(['127.0.0.1', 'localhost'].includes(database.hostname))
  assert.equal(database.pathname, '/mikka_e2e')
  assert.equal(database.search, ''); assert.equal(database.hash, '')
  for (const name of ['MIKKA_DATABASE_URL', 'DATABASE_URL']) assert.ok(env[name] === database.href, 'All database selectors must name the same isolated target')
  return database.href
}

async function regularBytes(root, path) {
  assert.ok(typeof path === 'string' && /^[A-Za-z0-9_./-]+$/.test(path) && !path.startsWith('/'))
  return regularPathBytes(root, path)
}

async function pinnedPosterBytes(root, directory, filename) {
  assert.match(filename, /^(?:ffmpeg|ffmpeg\.(?:README|LICENSE)|LICENSE|README\.md|package\.json)$/)
  return regularPathBytes(root, `${directory}/${filename}`)
}

async function regularPathBytes(root, path) {
  const parts = path.split('/')
  assert.ok(parts.every(part => part && part !== '.' && part !== '..'), 'Artifact paths must remain inside their build')
  let current = root
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const info = await lstat(current)
    assert.equal(info.isSymbolicLink(), false, 'Compiled evidence cannot follow symlinks')
    assert.ok(index === parts.length - 1 ? info.isFile() : info.isDirectory())
  }
  return readFile(current)
}

/** Only this pinned dependency may resolve pnpm's public package symlink. Its
 * exact store directory and every actual source file still reject symlinks. */
async function posterPackageDirectory(root) {
  const version = JSON.parse(await regularBytes(root, 'package.json')).dependencies?.['ffmpeg-static']
  assert.match(version, /^\d+\.\d+\.\d+$/)
  const lock = loadYaml((await regularBytes(root, 'pnpm-lock.yaml')).toString())
  const dependency = lock?.importers?.['.']?.dependencies?.['ffmpeg-static']
  assert.equal(dependency?.specifier, version, 'FFmpeg specifier must match the frozen lock')
  const key = `ffmpeg-static@${version}`, patch = lock?.patchedDependencies?.[key]
  let resolution = version, store = key
  if (patch !== undefined) {
    assert.equal(version, '5.3.0', 'Only the reviewed FFmpeg version may use a patch')
    assert.equal(patch?.path, 'patches/ffmpeg-static@5.3.0.patch', 'FFmpeg patch path must be exact')
    assert.match(patch?.hash, /^[a-f0-9]{64}$/)
    // pnpm 10 hashes patch text after normalizing CRLF to LF.
    const patchText = (await regularPathBytes(root, patch.path)).toString().replaceAll('\r\n', '\n')
    assert.equal(hash(patchText), patch.hash, 'FFmpeg patch must match its frozen lock hash')
    resolution += `(patch_hash=${patch.hash})`
    store += `_patch_hash=${patch.hash}`
  }
  assert.equal(dependency?.version, resolution, 'FFmpeg resolution must match the frozen lock')
  assert.ok(Object.hasOwn(lock?.snapshots ?? {}, `ffmpeg-static@${resolution}`), 'FFmpeg snapshot must exist in the frozen lock')
  const directory = `node_modules/.pnpm/${store}/node_modules/ffmpeg-static`
  assert.equal(await realpath(join(root, 'node_modules/ffmpeg-static')), join(root, directory), 'FFmpeg must be the exact pinned pnpm package')
  const metadata = JSON.parse(await pinnedPosterBytes(root, directory, 'package.json'))
  assert.equal(metadata.name, 'ffmpeg-static'); assert.equal(metadata.version, version)
  return directory
}

/** Compare the build's actual packaged resources with both its manifest and
 * tracked source. A list of filenames alone is not deployment evidence. */
export async function verifyRuntimeResources(root, built) {
  root = await realpath(root)
  assert.ok(Array.isArray(built.resources))
  const paths = new Set()
  const posters = new Map()
  let posterPackage
  for (const resource of built.resources) {
    assert.ok(resource && typeof resource.path === 'string' && !paths.has(resource.path))
    paths.add(resource.path)
    assert.match(resource.sha256, /^[a-f0-9]{64}$/)
    assert.ok(Number.isSafeInteger(resource.bytes) && resource.bytes >= 0)
    const packed = await regularBytes(root, `.output/${resource.path}`)
    assert.equal(packed.length, resource.bytes); assert.equal(hash(packed), resource.sha256)
    if (posterResources.has(resource.path)) {
      posters.set(resource.path, packed)
      const license = POSTER_LICENSE_FILES.find(name => resource.path === `${POSTER_RUNTIME_DIRECTORY}/${name}`)
      if (!license) continue
      posterPackage ??= await posterPackageDirectory(root)
      const source = await pinnedPosterBytes(root, posterPackage, license)
      assert.equal(source.length, resource.bytes); assert.equal(hash(source), resource.sha256)
    } else {
      const source = await regularBytes(root, resource.path)
      assert.equal(source.length, resource.bytes); assert.equal(hash(source), resource.sha256)
    }
  }
  if (built.posterBinary !== undefined || posters.size) {
    for (const path of posterResources) assert.ok(posters.has(path), `Required FFmpeg runtime file must be packaged: ${path}`)
    const manifest = JSON.parse(posters.get(POSTER_BINARY_MANIFEST).toString())
    assert.deepEqual(manifest, built.posterBinary)
    assert.equal(manifest.version, 1)
    for (const size of [manifest.bytes, manifest.gzipBytes]) assert.ok(Number.isSafeInteger(size) && size > 0 && size <= POSTER_BINARY_MAX_BYTES)
    for (const digest of [manifest.sha256, manifest.gzipSha256]) assert.match(digest, /^[a-f0-9]{64}$/)
    posterPackage ??= await posterPackageDirectory(root)
    const source = await pinnedPosterBytes(root, posterPackage, 'ffmpeg'), packed = posters.get(POSTER_BINARY_ARCHIVE)
    assert.equal(source.length, manifest.bytes); assert.equal(hash(source), manifest.sha256)
    assert.equal(packed.length, manifest.gzipBytes); assert.equal(hash(packed), manifest.gzipSha256)
    const expanded = await decompress(packed, { maxOutputLength: manifest.bytes })
    assert.equal(expanded.length, source.length); assert.equal(hash(expanded), hash(source), 'Packaged FFmpeg must expand to the exact pinned executable')
  }
  for (const path of requiredRuntimeResources) assert.ok(paths.has(path), `Required runtime file must be packaged: ${path}`)
  return { count: paths.size, required: [...requiredRuntimeResources] }
}

export async function inspectAnalyticsBuild(root = process.cwd()) {
  root = await realpath(root)
  const built = await readCompiledBuild(root)
  const resources = await verifyRuntimeResources(root, built)
  const manifestBytes = await regularBytes(root, 'apps/frontend/dist/web/.vite/manifest.json')
  const manifest = JSON.parse(manifestBytes.toString())
  const entries = Object.values(manifest)
  assert.ok(entries.some(entry => entry?.isEntry === true), 'Vite must publish a real application entry')
  const files = [...new Set(entries.map(entry => entry?.file).filter(file => typeof file === 'string' && file.endsWith('.js')))]
  assert.ok(files.length > 0)
  const assets = new Map(), configuredAssets = new Set()
  for (const file of files) {
    assert.match(file, /^assets\/[A-Za-z0-9_.-]+\.js$/)
    const [source, packed] = await Promise.all([
      regularBytes(root, `apps/frontend/dist/web/${file}`), regularBytes(root, `.output/public/mikka/${file}`),
    ])
    assert.equal(hash(source), hash(packed), 'The served asset must match the real Vite output')
    const path = `/mikka/${file}`
    assets.set(path, hash(packed))
    if (packed.includes(Buffer.from(analyticsKey))) configuredAssets.add(path)
  }
  assert.ok(configuredAssets.size > 0, 'Synthetic analytics configuration must be compiled into actual JavaScript')
  return { built, resources, assets, configuredAssets, manifestSha256: hash(manifestBytes) }
}

export function localAnalyticsRequest(value, origin) {
  try {
    const url = new URL(value), expected = new URL(origin)
    if (url.username || url.password || !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false
    if (url.protocol === 'ws:') url.protocol = 'http:'
    else if (url.protocol === 'wss:') url.protocol = 'https:'
    return url.origin === expected.origin
  } catch { return false }
}

export function syntheticPostHogRequest(request) {
  const url = new URL(request.url())
  return url.protocol === 'https:' && /^(?:[a-z0-9-]+\.)*posthog\.com$/.test(url.hostname)
    && (url.href.includes(analyticsKey) || (request.postData() ?? '').includes(analyticsKey))
}

async function deadline(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

async function closeApplication(child, ended) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  try { await deadline(ended, 35_000, 'ANALYTICS_APPLICATION_STOP_TIMEOUT') }
  catch (error) {
    child.kill('SIGKILL')
    await deadline(ended, 5_000, 'ANALYTICS_APPLICATION_KILL_TIMEOUT')
    throw error
  }
}

export async function checkAnalytics({ root = process.cwd(), env = process.env } = {}) {
  root = await realpath(root)
  const database = analyticsEnvironment(env)
  const build = await inspectAnalyticsBuild(root)
  const port = 3186, origin = `http://localhost:${port}`
  const serverEnv = { PATH: env.PATH, NODE_ENV: 'production', CI: 'true',
    MIKKA_EDITION: 'cloud',
    BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: 'synthetic-ssr-regression-secret-not-a-real-credential',
    E2E_DATABASE_URL: database, DATABASE_URL: database, MIKKA_DATABASE_URL: database,
    // The browser key is already proven in the compiled assets. Disabling the
    // server token prevents anonymous flag lookups from contacting PostHog.
    NEXT_PUBLIC_POSTHOG_KEY: '', NEXT_TELEMETRY_DISABLED: '1' }
  const child = spawn(process.execPath, ['scripts/start-app.mjs', '--hostname', 'localhost', '--port', String(port)], {
    cwd: root, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ended = Promise.withResolvers(), ready = Promise.withResolvers()
  let recent = '', serverFailure = false, browser
  child.once('error', error => { ready.reject(error); ended.resolve() })
  child.once('exit', () => { ready.reject(new Error('ANALYTICS_APPLICATION_EXITED')); ended.resolve() })
  child.stdout.on('data', bytes => {
    recent = (recent + bytes.toString()).slice(-2048)
    if (/Ready in\s+\d+/u.test(recent)) ready.resolve()
  })
  child.stderr.on('data', bytes => {
    if (/Cannot read properties of null|Invalid hook call/u.test(bytes.toString())) serverFailure = true
  })
  ready.promise.catch(() => {})
  try {
    await deadline(ready.promise, 60_000, 'ANALYTICS_APPLICATION_START_TIMEOUT')
    const { chromium, expect } = await import('@playwright/test')
    browser = await chromium.launch({ headless: true, chromiumSandbox: true })
    const results = []
    for (const path of analyticsPaths) {
      const locale = path.startsWith('/mikka/en/') ? 'en' : 'zh-CN'
      const messages = JSON.parse(await readFile(join(root, 'messages', `${locale}.json`), 'utf8'))
      const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block' })
      const analytics = Promise.withResolvers(), loaded = new Set(), pending = []
      let blocked = 0, pageErrors = 0
      try {
        await context.route('**/*', async route => {
          const request = route.request()
          if (localAnalyticsRequest(request.url(), origin)) { await route.continue(); return }
          blocked++
          if (syntheticPostHogRequest(request)) analytics.resolve()
          await route.abort('blockedbyclient')
        })
        await context.routeWebSocket('**/*', socket => {
          if (localAnalyticsRequest(socket.url(), origin)) socket.connectToServer()
          else { blocked++; socket.close() }
        })
        const page = await context.newPage()
        page.on('pageerror', () => { pageErrors++ })
        page.on('response', response => {
          const url = new URL(response.url())
          if (url.origin !== origin || !build.assets.has(url.pathname)) return
          const verified = (async () => {
            assert.equal(response.status(), 200)
            const bytes = await response.body()
            assert.equal(hash(bytes), build.assets.get(url.pathname), 'Browser bytes must be the reviewed bundled asset')
            loaded.add(url.pathname)
          })()
          verified.catch(() => {})
          pending.push(verified)
        })
        const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        assert.equal(response?.status(), 200, 'The actual anonymous page must load')
        const app = page.locator('#root')
        await expect(app.getByRole('heading', { name: messages.Auth.welcome, exact: true })).toBeVisible()
        await expect(app.locator('input[name="email"]')).toBeEditable()
        await expect(app.locator('input[name="password"]')).toBeEditable()
        await expect(page.locator('html')).toHaveAttribute('lang', locale)
        await deadline(analytics.promise, 15_000, 'ANALYTICS_BROWSER_INITIALIZATION_MISSING')
        await deadline(Promise.all(pending), 30_000, 'ANALYTICS_ASSET_BODY_TIMEOUT')
        assert.ok([...build.configuredAssets].some(asset => loaded.has(asset)), 'The browser must execute an asset containing the synthetic project')
        assert.equal(pageErrors, 0, 'The actual React application must mount without page errors')
        assert.equal(serverFailure, false, 'The server must remain free of React initialization errors')
        results.push({ path, locale, status: 'pass', loadedAssets: loaded.size, blockedExternalRequests: blocked, pageErrors })
      } finally { await context.close() }
    }
    return { revision: build.built.revision, runtime: 'vite-nitro', analytics: 'synthetic-enabled-network-blocked',
      assetManifestSha256: build.manifestSha256, runtimeResources: build.resources, paths: results }
  } finally {
    try { await browser?.close() }
    finally { await closeApplication(child, ended.promise) }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') === '--check-build') {
    analyticsEnvironment()
    const result = await inspectAnalyticsBuild()
    console.log(JSON.stringify({ status: 'pass', revision: result.built.revision, assets: result.assets.size, runtimeResources: result.resources }))
  } else {
    assert.equal(process.argv.length, 2, 'Unknown analytics checker argument')
    console.log(JSON.stringify(await checkAnalytics()))
  }
}
