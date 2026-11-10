import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { frontendRuntimeSource } from '../apps/frontend/scripts/frontend-runtime.mjs'
import { analyticsPath, sanitizeAnalyticsEvent } from '../lib/analytics-policy.ts'
import { FIRST_TOUCH_COOKIE, firstTouchFromPage, firstTouchCookieHeader, parseFirstTouch, rememberFirstTouch } from '../lib/first-touch.mjs'
import { computerAcceptancePreview, computerProductionEnabled, featureAvailability, gatedFeatureEnabled, gatedFeatures, killSwitches, proactiveFeatures, upcomingFeatures } from '../lib/feature-flags.ts'
import { analyticsEnvironment, analyticsKey, analyticsPaths, inspectAnalyticsBuild, localAnalyticsRequest, requiredRuntimeResources, syntheticPostHogRequest, verifyRuntimeResources } from '../scripts/check-analytics-ssr.mjs'
import { analyticsBrowserProfile } from '../scripts/analytics-browser-sandbox.mjs'
import { POSTER_BINARY_ARCHIVE, POSTER_BINARY_MANIFEST, POSTER_LICENSE_FILES, POSTER_RUNTIME_DIRECTORY } from '../lib/captures/poster-binary.mjs'

test('pageviews strip query strings, hashes, document identifiers and unapproved properties', () => {
  const event = sanitizeAnalyticsEvent({ event: '$pageview', properties: {
    $current_url: 'https://example.com/documents/01234567-89ab-cdef-0123-456789abcdef?email=private@example.com#secret',
    token: 'public-project-token', distinct_id: 'opaque-user-id', section: 'general',
    email: 'private@example.com', name: 'Private Name', $referrer: 'https://example.com/?token=secret',
    $set: { email: 'private@example.com' }, $initial_current_url: 'https://example.com/?token=secret',
    $exception_list: ['private'], description: 'private document content',
  } })
  assert.deepEqual(event.properties, {
    token: 'public-project-token', distinct_id: 'opaque-user-id', section: 'general',
    $current_url: 'https://example.com/documents/:id', $pathname: '/documents/:id',
  })
  assert.equal(analyticsPath('/settings/teams'), '/settings/teams')
  assert.equal(analyticsPath('/invite/private-invitation-token'), '/invite/:token')
})

test('automatic top-level person mutations are stripped without losing ingestion metadata', () => {
  const event = sanitizeAnalyticsEvent({
    event: '$identify', uuid: 'event-id', timestamp: '2026-10-21T00:00:00Z',
    properties: { distinct_id: 'opaque-user-id' },
    $set: { email: 'private@example.com' },
    $set_once: { $initial_current_url: 'https://example.com/?token=private' },
    $unset: ['private-property'],
  })
  assert.deepEqual(event, {
    event: '$identify', uuid: 'event-id', timestamp: '2026-10-21T00:00:00Z',
    properties: { distinct_id: 'opaque-user-id' },
  })
})

test('unknown events and raw exception events never pass the allowlist', () => {
  for (const event of ['$exception', '$autocapture', 'unknown']) {
    assert.equal(sanitizeAnalyticsEvent({ event, properties: {} }), null)
  }
  assert.equal(sanitizeAnalyticsEvent(null), null)
  assert.deepEqual(sanitizeAnalyticsEvent({ event: '$pageview', properties: { $current_url: 'not a url' } }).properties, {})
  assert.deepEqual(sanitizeAnalyticsEvent({ event: 'mikka_team_created', properties: { name: 'private' } }).properties, {})
})

test('masked replay keeps only its transport payload and cannot mutate a person', () => {
  const payload = [{ type: 2, data: { node: { textContent: '***' } } }]
  const event = sanitizeAnalyticsEvent({ event: '$snapshot', properties: { $snapshot_data: payload, $snapshot_bytes: 10, $session_id: 'session', distinct_id: 'person', prompt: 'private', $current_url: 'https://example.com/?token=private' } })
  assert.deepEqual(event.properties, { $snapshot_data: payload, $snapshot_bytes: 10, $session_id: 'session', distinct_id: 'person' })
  const source = readFileSync(new URL('../instrumentation-client.ts', import.meta.url), 'utf8')
  assert.match(source, /maskAllInputs: true/)
  assert.match(source, /maskTextSelector: '\*'/)
  assert.match(source, /maskAllElementAttributes: true/)
  assert.match(source, /recordHeaders: false/)
  assert.match(source, /recordBody: false/)
})

test('all upcoming features fail closed, even if the remote switch is accidentally enabled', () => {
  for (const [feature, definition] of Object.entries(upcomingFeatures)) {
    assert.equal(definition.implemented, false)
    for (const remote of [undefined, false, true, 'control', 'true']) {
      assert.equal(featureAvailability(feature, remote).enabled, false)
      assert.equal(featureAvailability(feature, remote).key, definition.key)
    }
    assert.equal(featureAvailability(feature, true).reason, 'FeatureCopy.c_7a3f5896')
  }
})

test('gated features are on only when the remote flag is exactly true', () => {
  assert.equal(gatedFeatures.cloudComputer, 'mikka-cloud-computer')
  assert.equal(gatedFeatures.computerBilling, 'mikka-computer-billing')
  assert.deepEqual(proactiveFeatures, { profile: 'mikka-proactive-profile', research: 'mikka-proactive-research' })
  for (const remote of [undefined, false, 'control', 'true']) assert.equal(gatedFeatureEnabled(remote), false)
  assert.equal(gatedFeatureEnabled(true), true)
  assert.equal(computerAcceptancePreview('preview', '1'), true)
  for (const environment of [undefined, 'development', 'production']) assert.equal(computerAcceptancePreview(environment, '1'), false)
  for (const flag of [undefined, '0', 'true']) assert.equal(computerAcceptancePreview('preview', flag), false)
  assert.equal(computerProductionEnabled('production', '1'), true)
  for (const environment of [undefined, 'development', 'preview']) assert.equal(computerProductionEnabled(environment, '1'), false)
  for (const flag of [undefined, '0', 'true']) assert.equal(computerProductionEnabled('production', flag), false)
})

test('the 电脑 tab has its own kill switch, apart from the cloud computer rollout flag', () => {
  assert.equal(killSwitches.computerTab, 'mikka-computer-tab-off')
  assert.notEqual(killSwitches.computerTab, gatedFeatures.cloudComputer)
  const hook = readFileSync(new URL('../hooks/use-feature-availability.ts', import.meta.url), 'utf8')
  assert.match(hook, /export function useComputerTab\(\)[\s\S]*?killSwitches\.computerTab[\s\S]*?!== true/)
})

test('the active Vite web entry initializes PostHog and the shared application mounts its pageview tracker', () => {
  const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  assert.match(source('apps/frontend/src/index.tsx'), /import 'mikka:frontend-runtime'[\s\S]*await import\('\.\.\/\.\.\/desktop\/src\/renderer\/index'\)/)
  const plugin = source('apps/frontend/scripts/application-plugin.mjs')
  assert.match(plugin, /import \{ frontendRuntimeSource \} from '\.\/frontend-runtime\.mjs'/)
  assert.match(plugin, /if \(id === '\\0mikka:frontend-runtime'\) \{\s*return frontendRuntimeSource\(target, \{ development, frontend, renderer \}\)/)
  const frontend = fileURLToPath(new URL('../apps/frontend', import.meta.url))
  const renderer = fileURLToPath(new URL('../apps/desktop/src/renderer', import.meta.url))
  for (const development of [false, true]) {
    const code = frontendRuntimeSource('web', { development, frontend, renderer })
    const prefix = development ? 'globalThis[Symbol.for("openui.devtools.autoMount")] = true;\n' : ''
    assert.equal(code, `${prefix}import ${JSON.stringify(join(frontend, 'src/web/runtime.ts'))};\n`)
  }
  assert.match(source('apps/frontend/src/web/runtime.ts'), /import '@\/instrumentation-client'/)
  assert.match(source('instrumentation-client.ts'), /posthog\.init\(posthogConfig\.token/)
  assert.match(source('instrumentation-client.ts'), /capture_pageview: false/)
  assert.match(source('apps/desktop/src/renderer/app.tsx'), /<PlatformExtras \/>/)
  assert.match(source('apps/frontend/src/web/platform.tsx'), /posthogConfig\.token && <PostHogAnalytics \/>/)
})

test('analytics acceptance preserves the three real anonymous routes and isolated database restriction', () => {
  assert.deepEqual(analyticsPaths, ['/mikka', '/mikka/sign-in', '/mikka/en/sign-in'])
  const database = 'postgresql://e2e:disposable@127.0.0.1:5432/mikka_e2e'
  const env = { CI: 'true', NEXT_PUBLIC_POSTHOG_KEY: analyticsKey, E2E_DATABASE_URL: database, DATABASE_URL: database, MIKKA_DATABASE_URL: database }
  assert.equal(analyticsEnvironment(env), database)
  for (const change of [{ CI: 'false' }, { NEXT_PUBLIC_POSTHOG_KEY: 'another-project' }, { DATABASE_URL: database + '?options=other' },
    { E2E_DATABASE_URL: database.replace('127.0.0.1', 'remote.example') }, { E2E_DATABASE_URL: database.replace('/mikka_e2e', '/mikka') }]) {
    assert.throws(() => analyticsEnvironment({ ...env, ...change }))
  }
})

test('all non-local browser HTTP and WebSocket requests are blocked before sending analytics', () => {
  const origin = 'http://localhost:3186'
  for (const value of ['/mikka', 'http://localhost:3186/mikka', 'ws://localhost:3186/live']) {
    assert.equal(localAnalyticsRequest(value.startsWith('/') ? origin + value : value, origin), true)
  }
  for (const value of ['http://localhost:3187/mikka', 'http://127.0.0.1:3186/mikka', 'https://localhost:3186/mikka',
    'wss://localhost:3186/live', 'https://us.i.posthog.com/e/', 'https://other.example', 'file:///tmp/page', 'http://private@localhost:3186/mikka']) {
    assert.equal(localAnalyticsRequest(value, origin), false)
  }
  const request = (url, body = null) => ({ url: () => url, postData: () => body })
  assert.equal(syntheticPostHogRequest(request(`https://us-assets.i.posthog.com/array/${analyticsKey}/config.js`)), true)
  assert.equal(syntheticPostHogRequest(request('https://us.i.posthog.com/e/', JSON.stringify({ token: analyticsKey }))), true)
  assert.equal(syntheticPostHogRequest(request(`https://foreign.example/${analyticsKey}`)), false)
  assert.equal(syntheticPostHogRequest(request('https://us.i.posthog.com/e/', 'another-token')), false)
})

async function analyticsBuildFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mikka-analytics-artifacts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const write = async (path, value) => { const filename = join(root, path); await mkdir(dirname(filename), { recursive: true }); await writeFile(filename, value) }
  const resources = []
  for (const [index, path] of requiredRuntimeResources.entries()) {
    const source = `actual source ${index}\n`
    await write(path, source); await write(`.output/${path}`, source)
    resources.push({ path, bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex') })
  }
  const built = { version: 1, preset: 'node-server', basePath: '/mikka', revision: 'a'.repeat(40), node: process.version,
    appBuild: 'synthetic-build', testDeploymentSha: '', lockSha256: 'b'.repeat(64), routesSha256: 'c'.repeat(64), tracingSha256: 'd'.repeat(64), resources }
  await write('.output/mikka-build.json', JSON.stringify(built))
  await write('.output/server/mikka-entry.mjs', 'export {}\n')
  const script = `export const project = '${analyticsKey}';\n`
  await write('apps/frontend/dist/web/.vite/manifest.json', JSON.stringify({ 'index.html': { isEntry: true, file: 'assets/index-real.js' } }))
  await write('apps/frontend/dist/web/assets/index-real.js', script)
  await write('.output/public/mikka/assets/index-real.js', script)
  return { root, built, write }
}

test('analytics build proof checks actual packaged bytes, public Vite entry and the synthetic key', async t => {
  const { root, built, write } = await analyticsBuildFixture(t)
  const result = await inspectAnalyticsBuild(root)
  assert.equal(result.assets.size, 1)
  assert.deepEqual([...result.configuredAssets], ['/mikka/assets/index-real.js'])
  assert.equal(result.resources.count, 3)
  await write('.output/public/mikka/assets/index-real.js', 'wrong asset')
  await assert.rejects(inspectAnalyticsBuild(root), /served asset/)
  await assert.rejects(verifyRuntimeResources(root, { ...built, resources: built.resources.slice(1) }), /Required runtime/)
  await assert.rejects(verifyRuntimeResources(root, { ...built, resources: [...built.resources, built.resources[0]] }))
  await write(`.output/${requiredRuntimeResources[0]}`, 'changed packaged resource')
  await assert.rejects(verifyRuntimeResources(root, built))
})

test('artifact verification rejects escaping and symlinked files instead of accepting their filenames', async t => {
  const { root, built } = await analyticsBuildFixture(t)
  for (const path of ['../private', '/private', 'packages//private', 'packages/./private', 'packages\\private']) {
    await assert.rejects(verifyRuntimeResources(root, { resources: [{ ...built.resources[0], path }] }))
  }
  const source = requiredRuntimeResources[0]
  await rm(join(root, '.output', source))
  await symlink(join(root, source), join(root, '.output', source))
  await assert.rejects(verifyRuntimeResources(root, built), /symlinks/)
})

test('generated FFmpeg evidence verifies the pinned pnpm source, real decompression and unchanged symlink boundaries', async t => {
  const { root, built, write } = await analyticsBuildFixture(t)
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const packageDirectory = 'node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static'
  await write('package.json', JSON.stringify({ dependencies: { 'ffmpeg-static': '5.3.0' } }))
  await write('pnpm-lock.yaml', JSON.stringify({ importers: { '.': { dependencies: { 'ffmpeg-static': { specifier: '5.3.0', version: '5.3.0' } } } }, snapshots: { 'ffmpeg-static@5.3.0': {} } }))
  await write(`${packageDirectory}/package.json`, JSON.stringify({ name: 'ffmpeg-static', version: '5.3.0' }))
  const original = Buffer.from('locked executable fixture\n'), archive = gzipSync(original)
  await write(`${packageDirectory}/ffmpeg`, original)
  await symlink(join(root, packageDirectory), join(root, 'node_modules/ffmpeg-static'), 'dir')
  const manifest = { version: 1, bytes: original.length, sha256: digest(original), gzipBytes: archive.length, gzipSha256: digest(archive) }
  const packed = async (path, bytes) => {
    await write(`.output/${path}`, bytes)
    const resource = { path, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) }
    const previous = built.resources.findIndex(value => value.path === path)
    if (previous === -1) built.resources.push(resource)
    else built.resources[previous] = resource
  }
  for (const name of POSTER_LICENSE_FILES) {
    const bytes = `pinned upstream ${name}\n`
    await write(`${packageDirectory}/${name}`, bytes)
    await packed(`${POSTER_RUNTIME_DIRECTORY}/${name}`, bytes)
  }
  await packed(POSTER_BINARY_ARCHIVE, archive)
  await packed(POSTER_BINARY_MANIFEST, JSON.stringify(manifest))
  built.posterBinary = manifest
  assert.equal((await verifyRuntimeResources(root, built)).count, requiredRuntimeResources.length + 6)
  await assert.rejects(verifyRuntimeResources(root, { ...built,
    resources: built.resources.filter(resource => resource.path !== POSTER_BINARY_ARCHIVE) }), /Required FFmpeg runtime/)

  // Only the one public pnpm link is allowed. Packaged files and files inside
  // the resolved pinned package retain the original no-symlink invariant.
  await write('archive-source.gz', archive)
  await rm(join(root, '.output', POSTER_BINARY_ARCHIVE))
  await symlink(join(root, 'archive-source.gz'), join(root, '.output', POSTER_BINARY_ARCHIVE))
  await assert.rejects(verifyRuntimeResources(root, built), /symlinks/)
  await rm(join(root, '.output', POSTER_BINARY_ARCHIVE)); await packed(POSTER_BINARY_ARCHIVE, archive)
  await write(`${packageDirectory}/alternate`, original)
  await rm(join(root, packageDirectory, 'ffmpeg'))
  await symlink(join(root, packageDirectory, 'alternate'), join(root, packageDirectory, 'ffmpeg'))
  await assert.rejects(verifyRuntimeResources(root, built), /symlinks/)
  await rm(join(root, packageDirectory, 'ffmpeg')); await write(`${packageDirectory}/ffmpeg`, original)
  await rm(join(root, 'node_modules/ffmpeg-static'))
  await symlink(join(root, packageDirectory, '..'), join(root, 'node_modules/ffmpeg-static'), 'dir')
  await assert.rejects(verifyRuntimeResources(root, built), /exact pinned pnpm package/)
  await rm(join(root, 'node_modules/ffmpeg-static'))
  await symlink(join(root, packageDirectory), join(root, 'node_modules/ffmpeg-static'), 'dir')

  // Updating both compressed-file hashes cannot disguise different expanded
  // bytes: the checker independently compares the installed pinned executable.
  const changed = gzipSync(Buffer.alloc(original.length, 65))
  const forged = { ...manifest, gzipBytes: changed.length, gzipSha256: digest(changed) }
  await packed(POSTER_BINARY_ARCHIVE, changed)
  await packed(POSTER_BINARY_MANIFEST, JSON.stringify(forged))
  built.posterBinary = forged
  await assert.rejects(verifyRuntimeResources(root, built), /exact pinned executable/)
})

test('runtime separates the desktop shell and still drops other client details', () => {
  const event = sanitizeAnalyticsEvent({ event: '$pageview', properties: { runtime: 'electron', isDesktop: true, userAgent: 'private', platform: 'Mozilla/5.0' } })
  assert.deepEqual(event.properties, { runtime: 'electron' })
})

test('smoke accounts are recognised only by their +mikka-smoke tag, and the tag survives sanitizing', async () => {
  const { isSmokeAccountEmail } = await import('../lib/smoke-account.ts')
  for (const email of ['alex+mikka-smoke@gmail.com', 'alex+mikka-smoke-owner@gmail.com', 'ALEX+MIKKA-SMOKE-PEER@example.com']) assert.equal(isSmokeAccountEmail(email), true, email)
  for (const email of ['alex@gmail.com', 'alex+mikka-smoker@gmail.com', 'mikka-smoke@gmail.com', 'alex+other+mikka-smoke@@gmail.com', '', null, undefined]) assert.equal(isSmokeAccountEmail(email), false, String(email))
  const event = sanitizeAnalyticsEvent({ event: '$pageview', properties: { distinct_id: 'opaque-user-id', test_account: true } })
  assert.deepEqual(event.properties, { distinct_id: 'opaque-user-id', test_account: true })
})

async function analyticsBrowserFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mikka-analytics-browser-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, 'chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]), { mode: 0o755 })
  return { root, executable }
}

test('the CI AppArmor attachment authorizes only the actual installed headless Chromium path', async t => {
  const { root, executable } = await analyticsBrowserFixture(t)
  const profile = await analyticsBrowserProfile(root)
  assert.equal(profile, `abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile mikka-analytics-chromium "${executable}" flags=(unconfined) {\n  userns,\n}\n`)
  assert.equal(profile.includes('*'), false)
  assert.equal(profile.includes('sysctl'), false)
})

test('the CI AppArmor helper rejects missing and ambiguous installed browser revisions', async t => {
  const { root } = await analyticsBrowserFixture(t)
  await mkdir(join(root, 'chromium_headless_shell-1249'))
  await assert.rejects(analyticsBrowserProfile(root), /ANALYTICS_BROWSER_REVISION_AMBIGUOUS/)
  await rm(join(root, 'chromium_headless_shell-1248'), { recursive: true })
  await rm(join(root, 'chromium_headless_shell-1249'), { recursive: true })
  await assert.rejects(analyticsBrowserProfile(root), /ANALYTICS_BROWSER_REVISION_AMBIGUOUS/)
})

test('the CI AppArmor helper rejects glob syntax, path aliases, and executable symlinks', async t => {
  const { root, executable } = await analyticsBrowserFixture(t)
  for (const directory of [root + '*', root + '\n', root + '/..', root + '/./', 'relative/browser']) {
    await assert.rejects(analyticsBrowserProfile(directory), /ANALYTICS_BROWSER_DIRECTORY_/)
  }
  const linked = join(root, 'linked')
  await symlink(root, linked)
  await assert.rejects(analyticsBrowserProfile(linked), /ANALYTICS_BROWSER_DIRECTORY_SYMLINK/)
  await rm(executable)
  const outside = join(root, 'unapproved-binary')
  await writeFile(outside, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 })
  await symlink(outside, executable)
  await assert.rejects(analyticsBrowserProfile(root), /ANALYTICS_BROWSER_EXECUTABLE_SYMLINK/)
})

test('the CI AppArmor helper refuses non-executable or non-ELF files', async t => {
  const { root, executable } = await analyticsBrowserFixture(t)
  await chmod(executable, 0o644)
  await assert.rejects(analyticsBrowserProfile(root), /ANALYTICS_BROWSER_EXECUTABLE_INVALID/)
  await chmod(executable, 0o755)
  await writeFile(executable, '#!/bin/sh\nexit 0\n')
  await assert.rejects(analyticsBrowserProfile(root), /ANALYTICS_BROWSER_EXECUTABLE_NOT_ELF/)
})

test('patched FFmpeg provenance accepts only the exact frozen patch hash and original source boundaries', async t => {
  const { root, built, write } = await analyticsBuildFixture(t)
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const patch = '--- a/install.js\n+++ b/install.js\n@@ -1 +1 @@\n-old\n+bounded\n'
  const patchPath = 'patches/ffmpeg-static@5.3.0.patch', patchHash = digest(patch)
  const lockedVersion = `5.3.0(patch_hash=${patchHash})`
  const packageDirectory = `node_modules/.pnpm/ffmpeg-static@5.3.0_patch_hash=${patchHash}/node_modules/ffmpeg-static`
  const lock = {
    patchedDependencies: { 'ffmpeg-static@5.3.0': { hash: patchHash, path: patchPath } },
    importers: { '.': { dependencies: { 'ffmpeg-static': { specifier: '5.3.0', version: lockedVersion } } } },
    snapshots: { [`ffmpeg-static@${lockedVersion}`]: {} },
  }
  const writeLock = () => write('pnpm-lock.yaml', JSON.stringify(lock))
  await write('package.json', JSON.stringify({ dependencies: { 'ffmpeg-static': '5.3.0' } }))
  await writeLock(); await write(patchPath, patch)
  await write(`${packageDirectory}/package.json`, JSON.stringify({ name: 'ffmpeg-static', version: '5.3.0' }))
  const original = Buffer.from('locked executable fixture\n'), archive = gzipSync(original)
  await write(`${packageDirectory}/ffmpeg`, original)
  const publicLink = join(root, 'node_modules/ffmpeg-static')
  await symlink(join(root, packageDirectory), publicLink, 'dir')
  const manifest = { version: 1, bytes: original.length, sha256: digest(original), gzipBytes: archive.length, gzipSha256: digest(archive) }
  const packed = async (path, bytes) => {
    await write(`.output/${path}`, bytes)
    built.resources.push({ path, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) })
  }
  for (const name of POSTER_LICENSE_FILES) {
    const bytes = `pinned upstream ${name}\n`
    await write(`${packageDirectory}/${name}`, bytes)
    await packed(`${POSTER_RUNTIME_DIRECTORY}/${name}`, bytes)
  }
  await packed(POSTER_BINARY_ARCHIVE, archive)
  await packed(POSTER_BINARY_MANIFEST, JSON.stringify(manifest))
  built.posterBinary = manifest
  assert.equal((await verifyRuntimeResources(root, built)).count, requiredRuntimeResources.length + 6)

  // pnpm hashes patch text after CRLF normalization, not arbitrary store suffixes.
  await write(patchPath, patch.replaceAll('\n', '\r\n'))
  assert.equal((await verifyRuntimeResources(root, built)).count, requiredRuntimeResources.length + 6)
  await write(patchPath, patch + 'changed\n')
  await assert.rejects(verifyRuntimeResources(root, built), /FFmpeg patch must match its frozen lock hash/)
  await write(patchPath, patch)

  lock.importers['.'].dependencies['ffmpeg-static'].version = '5.3.0'
  await writeLock()
  await assert.rejects(verifyRuntimeResources(root, built), /FFmpeg resolution must match the frozen lock/)
  lock.importers['.'].dependencies['ffmpeg-static'].version = lockedVersion
  await writeLock()

  lock.patchedDependencies['ffmpeg-static@5.3.0'].path = 'patches/unrelated.patch'
  await writeLock()
  await assert.rejects(verifyRuntimeResources(root, built), /FFmpeg patch path must be exact/)
  lock.patchedDependencies['ffmpeg-static@5.3.0'].path = patchPath
  await writeLock()

  const wrongDirectory = `node_modules/.pnpm/ffmpeg-static@5.3.0_patch_hash=${'0'.repeat(64)}/node_modules/ffmpeg-static`
  await mkdir(join(root, wrongDirectory), { recursive: true })
  await rm(publicLink); await symlink(join(root, wrongDirectory), publicLink, 'dir')
  await assert.rejects(verifyRuntimeResources(root, built), /exact pinned pnpm package/)
  await rm(publicLink); await symlink(join(root, packageDirectory), publicLink, 'dir')

  await write('saved.patch', patch)
  await rm(join(root, patchPath)); await symlink(join(root, 'saved.patch'), join(root, patchPath))
  await assert.rejects(verifyRuntimeResources(root, built), /symlinks/)
  await rm(join(root, patchPath)); await write(patchPath, patch)
  await write(`${packageDirectory}/alternate`, original)
  await rm(join(root, packageDirectory, 'ffmpeg'))
  await symlink(join(root, packageDirectory, 'alternate'), join(root, packageDirectory, 'ffmpeg'))
  await assert.rejects(verifyRuntimeResources(root, built), /symlinks/)
})


test('pageview accepts only validated referring hostname and UTM tags', () => {
  const event = sanitizeAnalyticsEvent({ event: '$pageview', properties: {
    $current_url: 'https://app.aspectlylabs.com/mikka/sign-up?email=private@example.com',
    $referring_domain: 'github.com',
    $referrer: 'https://github.com/search?token=private',
    utm_source: 'GitHub', utm_medium: 'SOCIAL', utm_campaign: 'mikka_launch',
    utm_content: 'private@example.com', utm_term: '../../secret',
    '$set_once': { email: 'private@example.com' },
  } })
  assert.equal(event.properties.$referring_domain, 'github.com')
  assert.equal(event.properties.utm_source, 'github')
  assert.equal(event.properties.utm_medium, 'social')
  assert.equal(event.properties.utm_campaign, 'mikka_launch')
  assert.equal(event.properties.utm_content, undefined)
  assert.equal(event.properties.utm_term, undefined)
  assert.equal(JSON.stringify(event).includes('private'), false)
  assert.equal(JSON.stringify(event).includes('token='), false)
})

test('first-touch referral survives marketing to App to signup without persisting secret URL values', () => {
  const now = 1760000000000
  const touch = firstTouchFromPage('https://aspectlylabs.com/mikka?utm_source=reddit&utm_medium=social&utm_campaign=launch_2026',
    'https://www.google.com/search?q=private@example.com', now)
  const cookie = firstTouchCookieHeader(touch, 'aspectlylabs.com', 'https:')
  assert.match(cookie, /Domain=aspectlylabs.com/)
  const incoming = cookie.split(';')[0]
  const parsed = parseFirstTouch(incoming, now + 5000)
  assert.equal(parsed.source, 'reddit')
  assert.equal(parsed.referrer_domain, 'www.google.com')
  assert.equal(parsed.utm_campaign, 'launch_2026')
  assert.equal(JSON.stringify(parsed).includes('private'), false)
  let writes = 0
  const fromApp = rememberFirstTouch('https://app.aspectlylabs.com/mikka/sign-up',
    'https://aspectlylabs.com/mikka', incoming, () => { writes++ }, now + 5000)
  assert.equal(fromApp.source, 'reddit')
  assert.equal(writes, 0)
  assert.equal(parseFirstTouch(`${FIRST_TOUCH_COOKIE}=${encodeURIComponent(JSON.stringify({ v: 1, acquired_at: now, source: 'mail@example.com' }))}`, now), null)
})

test('signup conversion event is attached to user creation, not sign-in handlers', () => {
  const auth = readFileSync(new URL('../lib/auth.ts', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../lib/registration-analytics.ts', import.meta.url), 'utf8')
  assert.match(auth, /user: \{ create: \{[\s\S]*?after: async user => \{[\s\S]*?trackNewRegistration/)
  assert.match(source, /event: 'registration_completed'/)
  assert.match(source, /afterJob\('after:registration-analytics'/)
  assert.match(source, /parseFirstTouch/)
})
