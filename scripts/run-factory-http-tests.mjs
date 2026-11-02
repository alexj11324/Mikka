// The actual built app and ephemeral CI database are required for these probes.
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import pg from 'pg'
import { validateTarget, parseSummary, checkSummary } from './run-db-tests.mjs'
import { localDatabaseTarget, localTestAccountsMode } from './test-accounts/database-target.mjs'
import { roleTargetUrl } from '../tests/helpers/e2e-target.mjs'

validateTarget(process.env)
const origin = 'http://localhost:3100'
// Outside Actions each probe asserts it connects as its own role. In local
// test-account mode (docs/test-accounts.md) they are created or reused on the
// loopback *_e2e database with a fresh password per run; Actions keeps e2e.
const ROLES = { query: 'factory192', question: 'factoryquestions192', cycle: 'factorycycle192' }
async function probeDatabaseUrls(env) {
  const base = env.E2E_DATABASE_URL
  if (!localTestAccountsMode(env)) return { query: base, question: base, cycle: base }
  localDatabaseTarget(base)
  const admin = new pg.Client({ connectionString: base })
  await admin.connect()
  try {
    const urls = {}
    for (const [probe, role] of Object.entries(ROLES)) {
      const password = randomBytes(16).toString('hex')
      const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount > 0
      await admin.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN NOSUPERUSER PASSWORD ${admin.escapeLiteral(password)}`)
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
      for (const kind of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) await admin.query(`GRANT ALL ON ALL ${kind} IN SCHEMA public TO ${role}`)
      urls[probe] = roleTargetUrl(base, role, password)
    }
    return urls
  } finally {
    await admin.end()
  }
}
const urls = await probeDatabaseUrls(process.env)
const probes = [
  ['tests/factory-query-http.test.ts', { FACTORY_QUERY_LOCAL_HTTP: '1', FACTORY_QUERY_HTTP_ORIGIN: origin, FACTORY_QUERY_DATABASE_URL: urls.query }],
  // This probe runs the dispatch path in its own process through lib/db, so its application URLs are its role too.
  ['tests/factory-question-http.test.ts', { FACTORY_QUESTION_LOCAL_HTTP: '1', FACTORY_QUESTION_HTTP_ORIGIN: origin, FACTORY_QUESTION_DATABASE_URL: urls.question, MIKKA_DATABASE_URL: urls.question, DATABASE_URL: urls.question }],
  ['tests/factory-monitor-cycle-http.test.ts', { FACTORY_CYCLE_LOCAL_HTTP: '1', FACTORY_CYCLE_HTTP_ORIGIN: origin, FACTORY_CYCLE_TEST_URL: urls.cycle }],
]
// These rollout gates belong to this already-validated ephemeral test process.
// The built question endpoints exercise the same enabled consumers as dispatch.
const factoryEnv = { ...process.env, MIKKA_FACTORY_ROUTING_ENABLED: '1', MIKKA_FACTORY_LIFECYCLE_ENABLED: '1' }
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--port', '3100'], { stdio: 'inherit', env: factoryEnv })
try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error('Built application exited before readiness')
    try { ready = (await fetch(`${origin}/mikka/sign-in`)).ok } catch {}
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (!ready) throw new Error('Built application did not become ready')
  for (const [file, env] of probes) {
    const result = spawnSync(process.execPath, ['--import', './tests/support/server-only.mjs', '--import', 'tsx', '--test', file], { encoding: 'utf8', env: { ...factoryEnv, ...env }, maxBuffer: 16 << 20 })
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    const error = checkSummary(file, result.status, parseSummary(`${result.stdout}\n${result.stderr}`))
    if (error) throw new Error(error)
  }
} finally {
  if (server.exitCode === null) {
    const closed = once(server, 'close')
    server.kill('SIGTERM')
    await closed
  }
}
