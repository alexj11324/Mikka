import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { tsImport } from 'tsx/esm/api'
import { productionApplication, productionEnvironment, stopOwnedApplication } from './production-application.mjs'

const sha = 'a'.repeat(40)
const options = { expectedRevision: sha, hostname: 'localhost', port: 3004 }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mikka-production-launch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const write = async (path, value) => {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value))
  }
  return { root, write }
}
function nitro(overrides = {}) {
  return { version: 1, preset: 'node-server', revision: sha, node: process.version,
    basePath: '/mikka', appBuild: 'fixed-build', testDeploymentSha: sha,
    lockSha256: 'b'.repeat(64), routesSha256: 'c'.repeat(64), tracingSha256: 'd'.repeat(64), ...overrides }
}
test('the compiled Nitro revision launches with the metrics preload first', async t => {
  const { root, write } = await fixture(t)
  await write('.output/mikka-build.json', nitro())
  await write('.output/server/mikka-entry.mjs', 'export {}\n')
  const result = await productionApplication(root, { ...options, preload: '/tmp/exact-owned-metrics.cjs' })
  assert.equal(result.kind, 'nitro')
  assert.deepEqual(result.args, ['--require', '/tmp/exact-owned-metrics.cjs', join(root, 'scripts/start-app.mjs'), '--hostname', 'localhost', '--port', '3004'])
  await assert.rejects(productionApplication(root, { ...options, expectedRevision: 'e'.repeat(40) }), /COMPILED_REVISION_MISMATCH/)
})
// A Next build is no longer a launchable application: the directory fails
// closed instead of starting a server this repository does not build.
test('a Next-only directory is refused rather than launched', async t => {
  const { root, write } = await fixture(t)
  await write('.next/required-server-files.json', { config: { env: { MIKKA_TEST_BUILD_SHA: sha } } })
  await assert.rejects(productionApplication(root, options), { code: 'ENOENT' })
})
test('the new product uses start-app only after validating its compiled revision and entry', async t => {
  const { root, write } = await fixture(t)
  await write('.output/mikka-build.json', nitro())
  await write('.output/server/mikka-entry.mjs', 'export {}\n')
  const result = await productionApplication(root, options)
  assert.equal(result.kind, 'nitro'); assert.equal(result.appBuild, 'fixed-build')
  assert.deepEqual(result.args, [join(root, 'scripts/start-app.mjs'), '--hostname', 'localhost', '--port', '3004'])
  await write('.next/required-server-files.json', { config: { env: { MIKKA_TEST_BUILD_SHA: sha } } })
  await write('.output/mikka-build.json', nitro({ testDeploymentSha: '' }))
  await assert.rejects(productionApplication(root, options), /APP_COMPILED_REVISION_MISMATCH/)
})
test('missing compiled proof, symlinked manifests and malformed launch arguments fail closed', async t => {
  const { root, write } = await fixture(t)
  await assert.rejects(productionApplication(root, options), { code: 'ENOENT' })
  await write('elsewhere.json', nitro())
  await mkdir(join(root, '.output'))
  await symlink(join(root, 'elsewhere.json'), join(root, '.output/mikka-build.json'))
  await assert.rejects(productionApplication(root, options), /COMPILED_FILE_INVALID/)
  for (const patch of [{ expectedRevision: '' }, { expectedRevision: 'main' }, { port: 0 }, { port: 3.5 }, { hostname: 'localhost; echo unsafe' }]) {
    await assert.rejects(productionApplication(root, { ...options, ...patch }), /DESKTOP_TEST_/)
  }
})

test('shutdown waits for the actual owned child exit after its graceful signal', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null })
  const signals = []
  let completed = false
  const result = stopOwnedApplication(child, { signal: (_, name) => signals.push(name), graceMs: 1000 })
    .then(() => { completed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(signals, ['SIGTERM']); assert.equal(completed, false)
  child.exitCode = 0; child.emit('exit', 0)
  await result
  assert.equal(completed, true); assert.equal(child.listenerCount('exit'), 0)
})

test('a forced owned exit is proven but remains a failed shutdown, and an unproven exit fails separately', async () => {
  for (const exits of [true, false]) {
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null })
    const signals = []
    await assert.rejects(stopOwnedApplication(child, { graceMs: 5, killMs: 5, signal: (_, name) => {
      signals.push(name)
      if (name === 'SIGKILL' && exits) { child.signalCode = name; child.emit('exit', null, name) }
    } }), exits ? /STOP_FORCED/ : /STOP_UNPROVEN/)
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
    assert.equal(child.listenerCount('exit'), 0)
  }
  await stopOwnedApplication({ pid: 123, exitCode: 0, signalCode: null }, { signal: () => assert.fail('must not signal an exited PID') })
})

test('each idle listener authenticates browser RPC only at its own configured origin', async () => {
  const { createBrowserRpc } = await tsImport('../../../lib/browser-rpc/handler.ts', {
    parentURL: import.meta.url, tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const inherited = {
    BETTER_AUTH_URL: 'http://localhost:3000',
    AUTH_TRUSTED_ORIGINS: 'http://localhost:3000,http://localhost:3001',
    DATABASE_URL: 'same-isolated-database', MIKKA_DATABASE_URL: 'same-isolated-database',
    E2E_DATABASE_URL: 'same-isolated-database', MIKKA_TEST_DEPLOYMENT_SHA: sha,
    MIKKA_TEST_ENVIRONMENT_FILE: 'same-descriptor.json', DEVICE_GATEWAY_URL: 'http://localhost:8787',
  }
  const original = { ...inherited }
  const create = configured => {
    const calls = { authentication: 0, action: 0 }
    const handler = createBrowserRpc({
      trustedBaseURL: configured.BETTER_AUTH_URL,
      authenticate: async () => { calls.authentication++; return { owner: true } },
      scope: async (identity, work) => { assert.equal(identity.owner, true); return work() },
      actions: { fixture: {
        args: { safeParse: value => ({ success: Array.isArray(value) && value.length === 0, data: value }) },
        invoke: async () => { calls.action++; return 'same-owner-read' },
      } },
    })
    return { handler, calls }
  }
  const request = (urlOrigin, headerOrigin = urlOrigin, extra = {}) => new Request(`${urlOrigin}/mikka/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mikka-rpc': '1', origin: headerOrigin, ...extra },
    body: JSON.stringify({ version: 1, action: 'fixture', args: [] }),
  })

  // Reproduce the old inherited environment: AUTH_TRUSTED_ORIGINS does not
  // override the separate RPC same-origin policy, so the second port is denied.
  const old = create(inherited)
  const denied = await old.handler(request('http://localhost:3001'))
  assert.equal(denied.status, 403)
  assert.deepEqual(await denied.json(), { version: 1, ok: false, error: { code: 'desktop_rpc_request_invalid' } })
  assert.deepEqual(old.calls, { authentication: 0, action: 0 })

  for (const port of [3000, 3001]) {
    const origin = `http://localhost:${port}`
    const configured = productionEnvironment(inherited, { origin: inherited.BETTER_AUTH_URL, port })
    assert.deepEqual(configured, { ...original, BETTER_AUTH_URL: origin })
    assert.deepEqual(inherited, original, 'never change the descriptor origin or sibling process environment')
    const current = create(configured)
    const response = await current.handler(request(origin))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { version: 1, ok: true, result: 'same-owner-read' })
    assert.deepEqual(current.calls, { authentication: 1, action: 1 })
    const foreign = port === 3000 ? 'http://localhost:3001' : 'http://localhost:3000'
    for (const rejected of [
      request(origin, foreign), request(foreign, origin), request(origin, 'null'),
      request(origin, origin, { authorization: 'Bearer forbidden' }),
      request(origin, origin, { 'x-mikka-session-cache': 'forbidden' }),
    ]) {
      assert.equal((await current.handler(rejected)).status, 403)
    }
    assert.deepEqual(current.calls, { authentication: 1, action: 1 }, 'rejections still happen before authentication or actions')
  }
})
