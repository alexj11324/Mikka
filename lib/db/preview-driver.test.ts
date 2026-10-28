import assert from 'node:assert/strict'
import Module from 'node:module'
import { test } from 'node:test'
import pg from 'pg'
import { mikkaDatabaseURL, workspaceDatabaseURL } from './config'
import { migrationTargets } from '../../scripts/migration-targets.mjs'

test('Preview application, workspace and migration driver targets never consult inherited passwords', () => {
  const saved = { PGPASSWORD: process.env.PGPASSWORD, PGPASSFILE: process.env.PGPASSFILE, HOME: process.env.HOME }
  const loader = Module as unknown as { _load: (...args: unknown[]) => unknown }
  const originalLoad = loader._load
  let pgpassLoads = 0
  loader._load = function (...args: unknown[]) {
    if (args[0] === 'pgpass') { pgpassLoads++; throw new Error('unexpected pgpass access') }
    return originalLoad.apply(this, args)
  }
  try {
    // These are synthetic paths; no password file is created or read.
    process.env.PGPASSFILE = '/nonexistent/preview-test-pgpass'
    process.env.HOME = '/nonexistent/preview-test-home'
    for (const inherited of [undefined, 'inherited-fixture']) {
      if (inherited === undefined) delete process.env.PGPASSWORD
      else process.env.PGPASSWORD = inherited
      for (const pgpassfile of [undefined, '/nonexistent/preview-test-pgpass']) {
        if (pgpassfile === undefined) delete process.env.PGPASSFILE
        else process.env.PGPASSFILE = pgpassfile
        const env = { VERCEL_ENV: 'preview', DATABASE_URL: 'postgres://user:explicit-fixture@preview.invalid/db', PGPASSWORD: inherited }
        const targets = migrationTargets(env)
        const urls = [mikkaDatabaseURL(env), workspaceDatabaseURL(env), targets.MIKKA_DATABASE_URL, targets.DATABASE_URL]
        for (const connectionString of urls) {
          const pool = new pg.Pool({ connectionString })
          const client = new pg.Client(pool.options)
          let called = false
          ;(client as unknown as { _getPassword: (callback: () => void) => void })._getPassword(() => { called = true })
          assert.equal(called, true)
          assert.equal(client.password, 'explicit-fixture')
        }
        assert.throws(() => mikkaDatabaseURL({ ...env, DATABASE_URL: 'postgres://user@preview.invalid/db' }), /PREVIEW_DATABASE_URL_INVALID/)
        assert.throws(() => workspaceDatabaseURL({ ...env, DATABASE_URL: 'postgres://user@preview.invalid/db' }), /PREVIEW_DATABASE_URL_INVALID/)
        assert.throws(() => migrationTargets({ ...env, DATABASE_URL: 'postgres://user@preview.invalid/db' }), /PREVIEW_DATABASE_URL_INVALID/)
      }
    }
    assert.equal(pgpassLoads, 0)
  } finally {
    loader._load = originalLoad
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
