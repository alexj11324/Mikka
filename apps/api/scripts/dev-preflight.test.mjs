import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_DEVELOPMENT_DATABASE, configuredDatabase, overlayStatus, readDevelopmentAccount } from './dev-preflight.mjs'

test('no development account password lives in the source', () => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-account-'))
  try {
    assert.equal(readDevelopmentAccount(root), null, 'a fresh checkout has no stored account until the server runs')
    assert.match(join(root, '.cache', 'dev-runtime', 'dev-account.json'), /\.cache\/dev-runtime\/dev-account\.json$/, 'the account file lives inside the gitignored runtime directory')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the default development database is on this machine', () => {
  const url = new URL(DEFAULT_DEVELOPMENT_DATABASE)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'a development server must never default to a remote database')
})

test('an environment database wins over the default, and Mikka’s name wins over DATABASE_URL', () => {
  assert.equal(configuredDatabase({}), null)
  assert.deepEqual(configuredDatabase({ DATABASE_URL: 'postgres://a@127.0.0.1/x' }), { url: 'postgres://a@127.0.0.1/x', source: 'environment' })
  assert.equal(configuredDatabase({ DATABASE_URL: 'postgres://a@127.0.0.1/x', MIKKA_DATABASE_URL: 'postgres://b@127.0.0.1/y' })?.url, 'postgres://b@127.0.0.1/y')
  assert.equal(configuredDatabase({ DATABASE_URL: '   ' }), null, 'a blank value is not a database')
})

test('the overlay reports what the frontend will be able to render', t => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-overlay-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const absent = overlayStatus(root, '')
  assert.equal(absent.installed, false)
  assert.match(absent.notes[0], /sign-in, consent and handoff documents only/)

  const missing = overlayStatus(root, '.hosted-ui')
  assert.equal(missing.installed, false)
  assert.match(missing.notes[0], /does not exist/)

  mkdirSync(join(root, '.hosted-ui', 'components'), { recursive: true })
  const uninstalled = overlayStatus(root, '.hosted-ui')
  assert.equal(uninstalled.installed, false)
  assert.equal(uninstalled.missingDependencies, true, 'an overlay without its own node_modules cannot compile')

  mkdirSync(join(root, '.hosted-ui', 'node_modules'), { recursive: true })
  const ready = overlayStatus(root, '.hosted-ui')
  assert.equal(ready.installed, true)
  assert.equal(ready.missingDependencies, undefined)
})
