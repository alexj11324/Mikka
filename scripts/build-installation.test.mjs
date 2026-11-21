import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installationBuild } from './build-installation.mjs'

test('a public checkout builds only the server regardless of an operator-selected server edition', async () => {
  assert.equal(await installationBuild({}), 'build:server')
  assert.equal(await installationBuild({ MIKKA_EDITION: 'cloud', CI: 'true' }), 'build:server')
})

test('official releases require the checkout and a complete immutable revision', async t => {
  const checkout = mkdtempSync(join(tmpdir(), 'installation-build-'))
  t.after(() => rmSync(checkout, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim()
  git('init', '--quiet')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '--allow-empty', '-m', 'fixture')
  const directory = { MIKKA_UI_OVERLAY_DIR: checkout }
  const revision = { MIKKA_UI_OVERLAY_SHA: git('rev-parse', 'HEAD') }
  const nested = join(checkout, 'unversioned-provider')
  mkdirSync(nested)
  await assert.rejects(installationBuild({ MIKKA_UI_OVERLAY_DIR: nested, ...revision }), /independentCheckoutRequired/)
  for (const env of [directory, revision, { ...directory, MIKKA_UI_OVERLAY_SHA: 'main' }, { VERCEL: '1', VERCEL_ENV: 'production' }]) {
    await assert.rejects(installationBuild(env), /OFFICIAL_UI_CHECKOUT_AND_REVISION_REQUIRED/)
  }
  await assert.rejects(installationBuild({ ...directory, MIKKA_UI_OVERLAY_SHA: 'b'.repeat(40) }), /checkoutMismatch/)
  assert.equal(await installationBuild({ ...directory, ...revision }), 'build:app')
})
