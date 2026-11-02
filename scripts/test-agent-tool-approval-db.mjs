// Only disposable loopback PostgreSQL test databases are permitted, locally or in CI.
// Create a separate database; never touch a pre-existing database.
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'

const source = process.env.E2E_DATABASE_URL
if (!disposableDatabase(process.env) || process.env.MIKKA_DATABASE_URL !== source || process.env.DATABASE_URL !== source) throw new Error('Requires the same disposable loopback *_e2e database for all application targets')
const url = new URL(source)
const files = process.argv.slice(2)
if (files.length !== 2 || files[0] !== 'lib/agent-tool-approval/store.db.test.ts' || files[1] !== 'lib/agent-tool-approval/http.db.test.mts') throw new Error('Unexpected test scope')
const name = `approval_e2e_${randomBytes(12).toString('hex')}`
const client = new pg.Client({ connectionString: source })
let created = false
try {
  await client.connect()
  await client.query(`CREATE DATABASE "${name}"`)
  created = true
  url.pathname = `/${name}`
  const env = { ...process.env, APPROVAL_TEST_DATABASE_URL: url.toString() }
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--import', './scripts/server-test.mjs', '--import', 'tsx', '--test', file], { env, stdio: 'inherit' })
    if (result.status !== 0) { process.exitCode = result.status || 1; break }
  }
} finally {
  // Preserve the test database; the owning isolated harness controls its lifecycle.
  if (created) console.log(`Retained approval test database: ${name}`)
  await client.end()
}
