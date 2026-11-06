import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { productionApplication } from './production-application.mjs'

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
test('the old baseline launches its actual compiled Next revision with the metrics preload first', async t => {
  const { root, write } = await fixture(t)
  await write('.next/required-server-files.json', { config: { env: { MIKKA_TEST_BUILD_SHA: sha } } })
  const result = await productionApplication(root, { ...options, preload: '/tmp/exact-owned-metrics.cjs' })
  assert.equal(result.kind, 'next')
  assert.deepEqual(result.args, ['--require', '/tmp/exact-owned-metrics.cjs', join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', 'localhost', '--port', '3004'])
  await assert.rejects(productionApplication(root, { ...options, expectedRevision: 'e'.repeat(40) }), /COMPILED_REVISION_MISMATCH/)
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
  await write('elsewhere.json', { config: { env: { MIKKA_TEST_BUILD_SHA: sha } } })
  await mkdir(join(root, '.next'))
  await symlink(join(root, 'elsewhere.json'), join(root, '.next/required-server-files.json'))
  await assert.rejects(productionApplication(root, options), /COMPILED_FILE_INVALID/)
  for (const patch of [{ expectedRevision: '' }, { expectedRevision: 'main' }, { port: 0 }, { port: 3.5 }, { hostname: 'localhost; echo unsafe' }]) {
    await assert.rejects(productionApplication(root, { ...options, ...patch }), /DESKTOP_TEST_/)
  }
})
