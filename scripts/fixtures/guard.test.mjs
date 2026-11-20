import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { assertFixtureBuild, assertFixtureRuntime, fixtureDatabase } from './guard.mjs'

const env = { DATABASE_URL: 'postgresql://fixture:local@127.0.0.1:5432/ui_e2e' }
const local = { preset: 'node-server', target: 'local-fixture' }

test('fixture auth refuses a release build even when NODE_ENV is development', () => {
  for (const built of [{ preset: 'node-server' }, { preset: 'node-server', target: 'production' }, { ...local, preset: 'vercel' }])
    assert.throws(() => assertFixtureRuntime({ env: { ...env, NODE_ENV: 'development' }, built, origin: 'http://127.0.0.1:3000' }), /FIXTURE_RELEASE_BUILD_FORBIDDEN/)
  assert.equal(assertFixtureRuntime({ env: { ...env, NODE_ENV: 'production' }, built: local, origin: 'http://127.0.0.1:3000' }).database.pathname, '/ui_e2e')
})

test('fixture seeds refuse remote, non-disposable, mixed databases and deployed builds before any write', () => {
  for (const url of ['postgres://fixture@db.example.test/ui_e2e', 'postgres://fixture@127.0.0.1/production',
    'postgres://fixture@127.0.0.1/ui_e2e?host=db.example.test', 'postgres://fixture@127.0.0.1/%75i_e2e'])
    assert.throws(() => fixtureDatabase({ DATABASE_URL: url }), /FIXTURE_DATABASE_NOT_DISPOSABLE/)
  assert.throws(() => fixtureDatabase({ ...env, MIKKA_DATABASE_URL: 'postgres://fixture@localhost/other_e2e' }), /FIXTURE_DATABASES_MUST_MATCH/)
  for (const remote of [{ VERCEL: '1' }, { VERCEL_ENV: 'preview' }, { NITRO_PRESET: 'vercel' }, { MIKKA_DEPLOYMENT_STAGE: 'production' }])
    assert.throws(() => assertFixtureBuild(remote), /FIXTURE_DEPLOYMENT_FORBIDDEN/)
  assert.throws(() => assertFixtureRuntime({ env, built: local, origin: 'http://0.0.0.0:3000' }), /FIXTURE_ORIGIN_NOT_LOOPBACK/)
})

test('fixture preload guards the same build when packaged Eve changes cwd', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-fixture-guard-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const scripts = join(root, 'scripts/fixtures')
  const eve = join(root, '.output/eve')
  const manifest = join(root, '.output/mikka-build.json')
  await mkdir(scripts, { recursive: true })
  await mkdir(eve, { recursive: true })
  for (const name of ['guard.mjs', 'preload.mjs']) {
    await copyFile(new URL(name, import.meta.url), join(scripts, name))
  }

  const run = cwd => spawnSync(process.execPath, ['--import', pathToFileURL(join(scripts, 'preload.mjs')).href, '-e', ''], {
    cwd, encoding: 'utf8', env: {
      ...env,
      MIKKA_FIXTURE_ORIGIN: 'http://127.0.0.1:3100',
      MIKKA_FIXTURE_SERVICES: 'http://127.0.0.1:3101',
      MIKKA_FIXTURE_GITHUB: 'http://127.0.0.1:3102',
      MIKKA_LITELLM_URL: 'http://127.0.0.1:3103',
    },
  })
  await writeFile(manifest, JSON.stringify(local))
  for (const cwd of [root, eve]) {
    const result = run(cwd)
    assert.equal(result.status, 0, result.stderr)
  }

  await mkdir(join(eve, '.output'))
  await writeFile(join(eve, '.output/mikka-build.json'), JSON.stringify(local))
  await writeFile(manifest, JSON.stringify({ ...local, target: 'production' }))
  const release = run(eve)
  assert.equal(release.status, 1)
  assert.match(release.stderr, /FIXTURE_RELEASE_BUILD_FORBIDDEN/)
})
