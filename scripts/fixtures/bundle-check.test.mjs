import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertNoFixtureAuthInOutput } from './bundle-check.mjs'
import { FIXTURE_LOGIN_PROXY_MARKER } from './proxy.mjs'

test('compiled output inspection rejects a fixture auth helper in either server or browser chunks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-fixture-bundle-')); t.after(() => rm(root, { recursive: true, force: true }))
  const server = join(root, '.output/server'), browser = join(root, 'apps/frontend/dist/web')
  await mkdir(server, { recursive: true }); await mkdir(browser, { recursive: true })
  await writeFile(join(server, 'index.mjs'), 'export const product = true\n'); await writeFile(join(browser, 'app.js'), 'window.product = true\n')
  assert.equal(await assertNoFixtureAuthInOutput(root), 2)
  for (const path of [join(server, 'login.mjs'), join(browser, 'login.js')]) {
    await writeFile(path, `export const marker = ${JSON.stringify(FIXTURE_LOGIN_PROXY_MARKER)}\n`)
    await assert.rejects(assertNoFixtureAuthInOutput(root), /FIXTURE_AUTH_ENTERED_PRODUCT_OUTPUT/)
    await rm(path)
  }
})
