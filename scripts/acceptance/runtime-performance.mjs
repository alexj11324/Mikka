// Opt-in Linux development comparison. This file does not import application
// code or start anything when imported. See runtime-performance.md first.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { arch, cpus, freemem, hostname, platform, release, totalmem } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

export const component = 'components/blocks/auth-19/components/auth.tsx'
export const documentPath = '/mikka/sign-in?login=1'
const anchor = '<main className="bg-background text-foreground flex min-h-svh w-full flex-col">'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const elapsed = since => Math.round((performance.now() - since) * 1000) / 1000
const inside = (root, path) => path.startsWith(root + sep)
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, maxBuffer: 8 * 1024 * 1024 }).trim()

export function markedSource(original, token) {
  assert.match(token, /^[a-z0-9-]+$/)
  const source = original.toString('utf8')
  assert.equal(source.split(anchor).length, 2, 'The exact existing auth main must occur once')
  assert.ok(!source.includes('data-mikka-perf-hmr'), 'The snapshot already has a performance edit')
  assert.ok(Buffer.from(source).equals(original), 'The component must round-trip as UTF-8')
  return Buffer.from(source.replace(anchor, anchor.replace('<main ', `<main data-mikka-perf-hmr="${token}" `)))
}

function safeError(error, redact) {
  return { name: String(error?.name ?? 'Error'), code: String(error?.code ?? 'PERFORMANCE_CHECK_FAILED'), message: redact(String(error?.message ?? error)).slice(0, 4000) }
}

export function redactor(values) {
  const secrets = [...new Set(values.filter(value => typeof value === 'string' && value.length >= 8))].sort((a, b) => b.length - a.length)
  return value => {
    let text = stripVTControlCharacters(String(value))
    for (const secret of secrets) text = text.replaceAll(secret, '[environment value]')
    return text.replace(/((?:https?|postgres(?:ql)?):\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[credentials]@')
  }
}

function bounded(promise, timeout, label, signal) {
  let timer, abort
  const failure = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeout)
    abort = () => reject(signal.reason ?? new Error('PERFORMANCE_INTERRUPTED'))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
  return Promise.race([promise, failure]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort) })
}

async function ownedPath(root, path, { file = false } = {}) {
  const resolved = await realpath(path)
  assert.ok(inside(root, resolved), 'Measured paths must stay inside the dedicated snapshot')
  const info = await lstat(path)
  assert.ok(!info.isSymbolicLink(), 'Measured source/cache paths cannot be symlinks')
  if (file) assert.ok(info.isFile() && info.nlink === 1 && info.uid === process.getuid(), 'The edited source must be an owned regular file, not a shared hardlink')
  return resolved
}

export async function cacheDirectory(root, path) {
  const absolute = resolve(root, path)
  assert.ok(inside(root, absolute), 'Cache must be inside its snapshot')
  let existing = absolute
  while (true) {
    try { await lstat(existing); break } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = resolve(existing, '..')
      assert.ok(parent !== existing && (parent === root || inside(root, parent)))
      existing = parent
    }
  }
  const actual = await realpath(existing)
  assert.ok(actual === root || inside(root, actual), 'A dependency symlink must not redirect the cache into another checkout')
  assert.equal(git(root, ['ls-files', '--', path]), '', 'Cache must not contain tracked files')
  assert.ok(git(root, ['check-ignore', '--', path + sep]), 'Only ignored build caches may be removed')
  return absolute
}

async function packageVersion(root, name, frontend = false) {
  // These are direct declared dependencies. Some packages intentionally do not
  // export package.json; read the installed manifest without importing code.
  const manifest = JSON.parse(await readFile(join(root, frontend ? 'apps/frontend/node_modules' : 'node_modules', name, 'package.json'), 'utf8'))
  assert.equal(manifest.name, name)
  return manifest.version
}

export async function preflight(config) {
  assert.equal(platform(), 'linux', 'This driver records Linux /proc process-group RSS')
  assert.notEqual(process.getuid(), 0, 'Run as an ordinary non-root user; Chromium sandbox stays enabled')
  assert.equal(config.nodeVersion, process.version, 'Use the explicitly recorded Node version')
  assert.ok(isAbsolute(config.snapshotsRoot) && isAbsolute(config.output))
  const snapshotsRoot = await realpath(config.snapshotsRoot)
  const protectedRoots = await Promise.all(config.protectedRoots.map(path => realpath(path)))
  assert.ok(protectedRoots.length > 0, 'List the main/developer checkout as protected')
  assert.deepEqual(config.targets.map(target => target.kind).sort(), ['next', 'vite'])
  assert.ok(Array.isArray(config.envNames) && config.envNames.every(name => /^[A-Z][A-Z0-9_]*$/.test(name)))
  assert.ok(!config.envNames.some(name => /^(?:NODE_OPTIONS|NODE_ENV|PORT|BETTER_AUTH_URL|VERCEL_GIT_COMMIT_SHA|MIKKA_DEV_SKIP_ENV_FILES)$/.test(name)), 'Runtime location/build controls are set per measured child')
  const env = Object.fromEntries(config.envNames.map(name => { assert.equal(typeof process.env[name], 'string', `Required environment variable ${name} is missing`); return [name, process.env[name]] }))
  const database = new URL(env.MIKKA_DATABASE_URL ?? env.DATABASE_URL)
  assert.ok(['postgres:', 'postgresql:'].includes(database.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(database.hostname), 'Use the existing real isolated loopback database')
  assert.ok(/(?:^|_)e2e$/.test(database.pathname.slice(1)), 'The database must be an existing isolated e2e database')
  for (const key of ['MIKKA_DATABASE_URL', 'DATABASE_URL', 'E2E_DATABASE_URL']) if (env[key]) assert.equal(new URL(env[key]).href, database.href)
  assert.ok(env.BETTER_AUTH_SECRET, 'Use the real isolated environment auth secret, not an invented identity')
  assert.notEqual(env.VERCEL_ENV, 'production', 'This is local development, not production')
  const targets = []
  for (const target of config.targets) {
    const root = await realpath(target.root)
    assert.ok(inside(snapshotsRoot, root), 'Only explicit dedicated snapshots are writable')
    assert.ok(!protectedRoots.some(path => root === path || inside(path, root) || inside(root, path)), 'Do not measure or edit a protected checkout')
    assert.equal(await realpath(git(root, ['rev-parse', '--show-toplevel'])), root)
    assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'Each snapshot must be detached at the fixed revision')
    assert.match(target.revision, /^[a-f0-9]{40}$/)
    assert.equal(git(root, ['rev-parse', 'HEAD']), target.revision)
    assert.equal(git(root, ['status', '--porcelain', '--untracked-files=all']), '', 'The snapshot must be clean')
    for (const name of ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local']) {
      try { await lstat(join(root, name)); throw new Error('PERFORMANCE_SNAPSHOT_ENV_FILE_FORBIDDEN') } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const origin = new URL(target.origin)
    assert.ok(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname) && origin.port && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password)
    assert.equal(target.origin, origin.origin, 'Specify the exact origin without a trailing slash')
    assert.ok(Array.isArray(target.command) && target.command.every(value => typeof value === 'string'))
    assert.equal(await realpath(target.command[0]), await realpath(process.execPath), 'Both commands must use the same explicit Node binary as this driver')
    const suffix = target.kind === 'next'
      ? ['node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', origin.hostname, '--port', origin.port]
      : ['apps/api/scripts/dev.mjs', '--host', origin.hostname, '--port', origin.port]
    assert.deepEqual(target.command.slice(1), suffix, 'Use the reviewed development commands without arbitrary switches')
    const expectedCaches = target.kind === 'next' ? ['.next'] : [`.cache/dev-runtime/${origin.port}`, 'apps/frontend/node_modules/.vite']
    assert.deepEqual(target.cachePaths, expectedCaches)
    const caches = await Promise.all(expectedCaches.map(path => cacheDirectory(root, path)))
    const source = await ownedPath(root, join(root, component), { file: true })
    assert.equal(git(root, ['ls-files', '--', component]), component)
    const original = await readFile(source)
    markedSource(original, 'preflight')
    const versions = { react: await packageVersion(root, 'react'), 'react-dom': await packageVersion(root, 'react-dom') }
    if (target.kind === 'next') versions.next = await packageVersion(root, 'next')
    else { versions.vite = await packageVersion(root, 'vite', true); versions.nitro = await packageVersion(root, 'nitro'); versions['@vitejs/plugin-react'] = await packageVersion(root, '@vitejs/plugin-react', true) }
    assert.deepEqual(versions, target.versions, 'Installed framework versions must match the explicit plan')
    const messages = JSON.parse(await readFile(join(root, 'messages/zh-CN.json'), 'utf8'))
    targets.push({ ...target, root, caches, source, original, sourceSha256: sha256(original), heading: messages.Auth.welcome, versions })
  }
  assert.notEqual(targets[0].root, targets[1].root)
  assert.notEqual(targets[0].origin, targets[1].origin)
  assert.equal(targets[0].sourceSha256, targets[1].sourceSha256, 'The measured React component must start byte-identical')
  assert.equal(targets[0].heading, targets[1].heading)
  assert.ok(!targets.some(target => resolve(config.output) === target.root || inside(target.root, resolve(config.output))))
  const browserRoot = await realpath(config.browser.packageRoot)
  const require = createRequire(join(browserRoot, 'package.json'))
  assert.equal(require('@playwright/test/package.json').version, config.browser.playwrightVersion)
  assert.ok(isAbsolute(config.browser.executablePath))
  await access(config.browser.executablePath)
  return { targets, env, chromium: require('@playwright/test').chromium }
}

async function processGroup(group) {
  const members = []
  await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(async name => {
    try {
      const line = await readFile(`/proc/${name}/stat`, 'utf8')
      const fields = line.slice(line.lastIndexOf(')') + 2).trim().split(/\s+/)
      if (Number(fields[2]) !== group || Number(fields[3]) !== group || fields[0] === 'Z') return
      const status = await readFile(`/proc/${name}/status`, 'utf8')
      const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
      members.push({ pid: Number(name), startTicks: fields[19], rssBytes: rss ? Number(rss[1]) * 1024 : 0 })
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error }
  }))
  return members
}

async function stopGroup(child, leaderStart) {
  if (!child?.pid) return { stopped: true, forced: false }
  let members = await processGroup(child.pid)
  if (!members.length) return { stopped: true, forced: false }
  const leader = members.find(member => member.pid === child.pid)
  assert.ok(!leader || !leaderStart || leader.startTicks === leaderStart, 'Refusing a reused process-group leader')
  try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  const waitGone = async timeout => {
    const deadline = performance.now() + timeout
    do { members = await processGroup(child.pid); if (!members.length) return true; await new Promise(resolve => setTimeout(resolve, 100)) } while (performance.now() < deadline)
    return false
  }
  if (await waitGone(30_000)) return { stopped: true, forced: false }
  const current = members.find(member => member.pid === child.pid)
  assert.ok(!current || !leaderStart || current.startTicks === leaderStart, 'Refusing a reused process-group leader')
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  assert.ok(await waitGone(5_000), 'Owned development process group did not stop')
  return { stopped: true, forced: true }
}

async function freePort(origin) {
  const url = new URL(origin), server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(url.port), url.hostname, resolve) })
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function coldAndHot({ target, iteration, browser, output, env, redact, signal, save }) {
  const result = { kind: target.kind, iteration, revision: target.revision, status: 'running', stage: 'preflight', startedAt: new Date().toISOString(), sourceSha256: target.sourceSha256, rssSamples: [] }
  let child, context, sampler, busy = false, leaderStart, edited, log
  const sourceRestored = async () => {
    const current = await readFile(target.source)
    assert.ok(current.equals(target.original) || (edited && current.equals(edited)), 'Source changed outside this measurement; preserve it instead of overwriting')
    if (!current.equals(target.original)) await writeFile(target.source, target.original)
    assert.equal(sha256(await readFile(target.source)), target.sourceSha256, 'Source bytes were not restored')
    assert.equal(git(target.root, ['status', '--porcelain', '--untracked-files=all']), '', 'Snapshot must be clean after the measurement')
    return true
  }
  await save(result)
  try {
    assert.equal(git(target.root, ['status', '--porcelain', '--untracked-files=all']), '')
    assert.equal(sha256(await readFile(target.source)), target.sourceSha256)
    await freePort(target.origin)
    for (const path of target.cachePaths) await rm(await cacheDirectory(target.root, path), { recursive: true, force: true })
    context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'UTC', serviceWorkers: 'block' })
    const page = await context.newPage()
    const errors = [], blocked = new Set()
    await context.addInitScript(() => { globalThis.__mikkaPerformanceDocument = crypto.randomUUID() })
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin === target.origin) await route.continue()
      else { blocked.add(new URL(route.request().url()).origin); await route.abort('blockedbyclient') }
    })
    await context.routeWebSocket('**/*', route => {
      const url = new URL(route.url()); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
      if (url.origin === target.origin) route.connectToServer()
      else { blocked.add(url.origin); route.close({ code: 1008, reason: 'Off-origin traffic blocked' }) }
    })
    page.on('pageerror', error => errors.push(safeError(error, redact)))
    log = createWriteStream(join(output, `${target.kind}-${iteration}.log`), { flags: 'wx', mode: 0o600 })
    let tail = ''
    const ready = Promise.withResolvers()
    void ready.promise.catch(() => {})
    result.stage = 'cold'
    const start = performance.now()
    const remaining = () => Math.max(1, 180_000 - elapsed(start))
    child = spawn(target.command[0], target.command.slice(1), { cwd: target.root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', ...env,
      NODE_ENV: 'development', BETTER_AUTH_URL: target.origin, PORT: new URL(target.origin).port,
      VERCEL_GIT_COMMIT_SHA: target.revision, MIKKA_DEV_SKIP_ENV_FILES: '1',
    } })
    child.once('error', error => ready.reject(error))
    child.once('exit', (code, terminatedBy) => { result.exit = { code, signal: terminatedBy }; ready.reject(new Error('DEVELOPMENT_PROCESS_EXITED_BEFORE_READY')) })
    const record = data => { const text = redact(data.toString()); log.write(text); tail = (tail + text).slice(-16_384); if (/Ready in \d+(?:\.\d+)?\s*(?:ms|s)/.test(tail)) ready.resolve() }
    child.stdout.on('data', record); child.stderr.on('data', record)
    const sample = async () => {
      if (busy || !child.pid) return
      busy = true
      try {
        const members = await processGroup(child.pid)
        leaderStart ??= members.find(member => member.pid === child.pid)?.startTicks
        result.rssSamples.push({ atMs: elapsed(start), bytes: members.reduce((sum, member) => sum + member.rssBytes, 0), processes: members.length })
      } finally { busy = false }
    }
    await sample()
    // OS memory sampling only. No application request or database polling.
    sampler = setInterval(() => { void sample().catch(error => ready.reject(error)) }, 250)
    await bounded(ready.promise, remaining(), 'DEVELOPMENT_START_TIMEOUT', signal)
    result.serverReadyMs = elapsed(start)
    const navigation = await bounded(page.goto(target.origin + documentPath, { waitUntil: 'domcontentloaded', timeout: remaining() }), remaining(), 'SIGN_IN_NAVIGATION_TIMEOUT', signal)
    result.httpStatus = navigation?.status() ?? null
    assert.equal(result.httpStatus, 200)
    await bounded((async () => {
      await page.getByRole('heading', { name: target.heading, exact: true }).waitFor({ state: 'visible', timeout: remaining() })
      const email = page.locator('main form input[name="email"]'), password = page.locator('main form input[name="password"]')
      await email.waitFor({ state: 'visible', timeout: remaining() })
      assert.equal(await email.isEditable(), true); assert.equal(await password.isEditable(), true)
      await password.focus({ timeout: remaining() })
      // SSR can precede React's delegated event listener. Probe this harmless
      // existing onClick once per frame until its real focus effect occurs;
      // do not mistake a single click lost before hydration for a failed app.
      const focus = await page.waitForFunction(() => {
        const email = document.querySelector('main form input[name="email"]')
        const addon = email?.parentElement?.querySelector('[data-slot="input-group-addon"]')
        if (!addon) return false
        const state = globalThis.__mikkaPerformanceFocusProbe ??= { attempts: 0, firstAtMs: performance.now() }
        state.attempts++; state.lastAtMs = performance.now()
        addon.click()
        return document.activeElement === email ? { ...state, spanMs: state.lastAtMs - state.firstAtMs } : false
      }, undefined, { polling: 'raf', timeout: remaining() })
      result.reactFocusProbe = await focus.jsonValue()
      await focus.dispose()
      await page.evaluate(() => { delete globalThis.__mikkaPerformanceFocusProbe })
      await email.fill('performance-probe@example.invalid', { timeout: remaining() }); assert.equal(await email.inputValue(), 'performance-probe@example.invalid')
      await password.fill('performance-local-only', { timeout: remaining() }); assert.equal(await password.inputValue(), 'performance-local-only')
      await email.fill('', { timeout: remaining() }); await password.fill('', { timeout: remaining() })
    })(), remaining(), 'SIGN_IN_INTERACTIVE_TIMEOUT', signal)
    result.coldInteractiveMs = elapsed(start)
    result.finalPath = new URL(page.url()).pathname + new URL(page.url()).search
    assert.equal(result.finalPath, documentPath, 'Do not count an acceptance redirect or another page')
    assert.deepEqual(errors, [], 'The real page must initialize without pageerror')
    await sample()
    result.coldRssBytes = result.rssSamples.at(-1)?.bytes
    result.coldPeakSampledRssBytes = Math.max(...result.rssSamples.map(sample => sample.bytes))
    result.stage = 'hmr'
    await save(result)
    const beforeDocument = await page.evaluate(() => globalThis.__mikkaPerformanceDocument)
    let navigations = 0
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++ })
    const token = `${target.kind}-${iteration}-${randomUUID()}`
    edited = markedSource(target.original, token)
    const hotStart = performance.now()
    await writeFile(target.source, edited)
    result.hmrWriteMs = elapsed(hotStart)
    await bounded(page.locator(`main[data-mikka-perf-hmr="${token}"]`).waitFor({ state: 'visible', timeout: 45_000 }), 45_000, 'HMR_DOM_UPDATE_TIMEOUT', signal)
    result.hmrDomMs = elapsed(hotStart)
    result.hmrDocumentNavigations = navigations
    result.fullDocumentReload = await page.evaluate(() => globalThis.__mikkaPerformanceDocument) !== beforeDocument
    assert.deepEqual(errors, [], 'The HMR update must not cause a pageerror')
    await sample()
    result.hmrRssBytes = result.rssSamples.at(-1)?.bytes
    result.peakSampledRssBytes = Math.max(...result.rssSamples.map(sample => sample.bytes))
    result.blockedExternalOrigins = [...blocked].sort()
    result.status = 'passed'
  } catch (error) {
    result.status = 'failed'; result.failure = safeError(error, redact)
    const page = context?.pages()[0]
    if (page && !page.isClosed()) {
      try { result.reactFocusProbe ??= await page.evaluate(() => globalThis.__mikkaPerformanceFocusProbe) } catch { /* The failed page may already be navigating/closing. */ }
      try { await page.screenshot({ path: join(output, `${target.kind}-${iteration}-failed.png`), timeout: 5000 }) } catch (screenshotError) { result.screenshotFailure = safeError(screenshotError, redact) }
    }
  } finally {
    clearInterval(sampler)
    result.cleanup = {}
    try { result.cleanup.sourceRestored = await sourceRestored() } catch (error) { result.cleanup.sourceFailure = safeError(error, redact) }
    try { await bounded(context?.close(), 10_000, 'BROWSER_CONTEXT_CLOSE_TIMEOUT'); result.cleanup.contextClosed = true } catch (error) { result.cleanup.contextFailure = safeError(error, redact) }
    try { result.cleanup.process = await stopGroup(child, leaderStart) } catch (error) { result.cleanup.processFailure = safeError(error, redact) }
    if (log) await new Promise(resolve => log.end(resolve))
    if (!result.cleanup.sourceRestored || !result.cleanup.contextClosed || !result.cleanup.process?.stopped || result.cleanup.process.forced) result.status = 'failed'
    result.finishedAt = new Date().toISOString()
    await save(result)
  }
  return result
}

export async function run(config, { check = false } = {}) {
  const { targets, env, chromium } = await preflight(config)
  if (check) return { checked: true, targets: targets.map(({ kind, revision, root, sourceSha256, versions }) => ({ kind, revision, root, sourceSha256, versions })) }
  const output = resolve(config.output)
  await mkdir(output, { recursive: false, mode: 0o700 })
  const redact = redactor(Object.values(env))
  const report = { version: 1, status: 'running', scriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))), startedAt: new Date().toISOString(), documentPath, component,
    method: { repetitions: 3, order: 'alternating-next-vite', cold: 'fresh process, fresh browser context, explicit compiler caches removed; OS page cache remains', hmr: 'one data attribute on the byte-identical existing React auth main', rss: 'sum of owned Linux process-group RSS sampled every 250 ms; browser excluded', serverTimeoutMs: 180000, hmrTimeoutMs: 45000, sandbox: true },
    host: { hostname: hostname(), platform: platform(), arch: arch(), release: release(), cpus: cpus().length, memoryBytes: totalmem(), freeMemoryBeforeBytes: freemem(), node: process.version },
    browser: { ...config.browser }, targets: targets.map(({ kind, revision, root, command, cachePaths, sourceSha256, versions, origin }) => ({ kind, revision, root, command, cachePaths, sourceSha256, versions, origin })), samples: [] }
  const save = async result => { if (!report.samples.includes(result)) report.samples.push(result); await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) }
  const abort = new AbortController()
  const interrupt = () => abort.abort(new Error('PERFORMANCE_INTERRUPTED'))
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
  let browser
  try {
    browser = await chromium.launch({ executablePath: config.browser.executablePath, chromiumSandbox: true, headless: true })
    assert.equal(browser.version(), config.browser.chromiumVersion, 'Chromium must match the planned version')
    report.browser.actualVersion = browser.version()
    for (let iteration = 1; iteration <= 3; iteration++) {
      for (const kind of ['next', 'vite']) {
        if (abort.signal.aborted) throw abort.signal.reason
        const target = targets.find(target => target.kind === kind)
        const result = await coldAndHot({ target, iteration, browser, output, env, redact, signal: abort.signal, save })
        if (!result.cleanup.sourceRestored || !result.cleanup.contextClosed || !result.cleanup.process?.stopped || result.cleanup.process.forced) throw new Error('PERFORMANCE_CLEANUP_FAILED_STOPPING_REMAINING_RUNS')
        if (result.status !== 'passed') throw new Error('PERFORMANCE_SAMPLE_FAILED_STOPPING_REMAINING_RUNS')
      }
    }
    report.status = report.samples.every(sample => sample.status === 'passed') ? 'passed' : 'failed'
    if (report.status === 'passed') {
      const median = values => [...values].sort((a, b) => a - b)[1]
      report.medians = Object.fromEntries(['next', 'vite'].map(kind => { const samples = report.samples.filter(sample => sample.kind === kind); return [kind, { coldInteractiveMs: median(samples.map(sample => sample.coldInteractiveMs)), hmrDomMs: median(samples.map(sample => sample.hmrDomMs)), peakSampledRssBytes: median(samples.map(sample => sample.peakSampledRssBytes)), fullDocumentReloads: samples.filter(sample => sample.fullDocumentReload).length }] }))
    }
  } catch (error) { report.status = 'failed'; report.failure = safeError(error, redact) }
  finally {
    try { await bounded(browser?.close(), 10_000, 'BROWSER_CLOSE_TIMEOUT'); report.browserClosed = true } catch (error) { report.status = 'failed'; report.browserCloseFailure = safeError(error, redact) }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
    report.finishedAt = new Date().toISOString()
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  assert.ok((args.length === 2 || args.length === 3) && args[0] === '--config' && isAbsolute(args[1]) && (args.length === 2 || args[2] === '--check'), 'Usage: node runtime-performance.mjs --config /absolute/config.json [--check]')
  const config = JSON.parse(await readFile(args[1], 'utf8'))
  try {
    const report = await run(config, { check: args.includes('--check') })
    console.log(JSON.stringify(report.checked ? report : { status: report.status, samples: report.samples.length, report: resolve(config.output, 'report.json') }))
    if (!report.checked && report.status !== 'passed') process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', stage: 'preflight', failure: safeError(error, redactor((config.envNames ?? []).map(name => process.env[name]))) }))
    process.exitCode = 1
  }
}
