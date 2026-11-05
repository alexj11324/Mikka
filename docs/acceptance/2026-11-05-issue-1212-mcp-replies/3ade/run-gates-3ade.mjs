import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { openSync, closeSync } from 'node:fs'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const root = '/vercel/sandbox/mikka-mcp-main-3ade-egress'
const out = '/vercel/acceptance/mcp-1255-3ade'
const phase = process.argv[2] ?? 'initial'
assert.match(phase, /^[a-z0-9-]+$/)
await mkdir(out, { recursive: true })
const require = createRequire(root + '/package.json')
const { Pool } = require('pg')
const { orderMigrations } = await import(pathToFileURL(root + '/scripts/migration-order.mjs').href)
const { disposableDatabase, APPLICATION_DATABASE_URLS } = await import(pathToFileURL(root + '/tests/helpers/e2e-target.mjs').href)
const suffix = randomBytes(6).toString('hex')
const role = `mcp_reply_${suffix}`
const database = `mcp_reply_${suffix}_e2e`
const password = randomBytes(32).toString('hex')
const url = `postgresql://${role}:${password}@127.0.0.1:5432/${database}`
const env = { ...process.env, CI: 'true', NODE_ENV: 'test', REQUIRE_DB: '1' }
for (const key of ['AI_GATEWAY_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'COMPOSIO_API_KEY', 'E2B_API_KEY', 'EXPO_ACCESS_TOKEN', 'POSTHOG_SECRET_KEY', 'RESEND_API_KEY', 'DEVICE_GATEWAY_URL', 'DEVICE_GATEWAY_PUSH_SECRET', 'FACTORY_QUESTION_TEST_URL']) delete env[key]
for (const key of APPLICATION_DATABASE_URLS) env[key] = url
assert.ok(disposableDatabase(env, url))
const results = []
const identity = { root, phase, role, database, startedAt: new Date().toISOString(), base: '3adee90c742b045e0eebd5854eecc6ade1c84aae', ownCommit: '4cbe8e04e3ce7eb35398fa67321fb70f584081a1', node: process.version, tree: execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim() }
function admin(sql) {
  return execFileSync('sudo', ['-u', 'postgres', 'psql', '-X', '-qAt', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}
async function run(label, args, timeout = 180_000) {
  const log = `${out}/${phase}-${label}.log`
  const fd = openSync(log, 'w'), startedAt = new Date().toISOString()
  let timedOut = false
  const child = spawn('npx', ['--yes', 'pnpm@10.34.3', ...args], { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] })
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM') } catch {} }, timeout)
  const force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, timeout + 5_000)
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
    const result = { label, args, log, startedAt, endedAt: new Date().toISOString(), timedOut, ...status }
    results.push(result)
    process.stdout.write(JSON.stringify(result) + '\n')
    return status.code === 0 && !timedOut
  } finally { clearTimeout(timer); clearTimeout(force); closeSync(fd) }
}
let fixture, created = false, ok = true
try {
  admin(`CREATE ROLE "${role}" LOGIN CREATEDB PASSWORD '${password}';\nCREATE DATABASE "${database}" OWNER "${role}" TEMPLATE template0;\n`)
  created = true
  await writeFile(`${out}/${phase}-identity.json`, JSON.stringify(identity, null, 2) + '\n')
  fixture = new Pool({ connectionString: url, max: 1 })
  const setup = []
  for (const name of orderMigrations((await readdir(root + '/drizzle')).filter(name => name.endsWith('.sql')))) {
    await fixture.query(await readFile(root + '/drizzle/' + name, 'utf8'))
    setup.push(name)
  }
  await writeFile(`${out}/${phase}-setup.json`, JSON.stringify({ ...identity, migrations: setup, server: (await fixture.query('SELECT version()')).rows[0].version, owner: (await fixture.query('SELECT current_user')).rows[0].current_user }, null, 2) + '\n')
  await fixture.end(); fixture = undefined
  const groups = [
    ['reply-wait', ['exec', 'node', '--import', 'tsx', '--test', 'lib/mcp/reply-wait.test.ts']],
    ['mcp-pg', ['exec', 'node', '--experimental-test-module-mocks', '--import', './scripts/server-test.mjs', '--import', 'tsx', '--test', 'lib/mcp/reply-live.db.test.ts']],
    ['schedules-pg', ['test:schedules-db']],
    ['gateway', ['test:device-gateway']],
    ['coordinator', ['test:coordinator-events']],
    ['schedules', ['test:schedules']],
    ['typecheck', ['typecheck']],
    ['lint', ['lint']],
  ]
  const requested = new Set(process.argv.slice(3))
  for (const name of requested) assert.ok(groups.some(([label]) => label === name), 'unknown gate')
  for (const [label, args] of groups) if (!requested.size || requested.has(label)) ok = await run(label, args) && ok
} catch (error) {
  ok = false
  const message = String(error?.stack ?? error).replaceAll(password, '[local password redacted]').replaceAll(url, '[isolated local database]')
  await writeFile(`${out}/${phase}-runner-error.log`, message + '\n')
  process.stdout.write(JSON.stringify({ runnerError: true, log: `${out}/${phase}-runner-error.log` }) + '\n')
} finally {
  await fixture?.end()
  const cleanup = { ...identity, completedAt: new Date().toISOString(), created, drops: [], connections: [], roleDropped: false }
  if (created) {
    const rows = admin(`SELECT datname FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname='${role}') ORDER BY datname;`).trim().split('\n').filter(Boolean)
    for (const name of rows) {
      assert.match(name, /^[a-z0-9_]+_e2e$/)
      const connections = admin(`SELECT pid::text FROM pg_stat_activity WHERE datname='${name}' AND backend_type='client backend';`).trim().split('\n').filter(Boolean)
      cleanup.connections.push({ database: name, pids: connections })
      if (connections.length) { ok = false; continue }
      admin(`DROP DATABASE "${name}";`)
      cleanup.drops.push(name)
    }
    cleanup.remainingOwnedDatabases = admin(`SELECT datname FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname='${role}') ORDER BY datname;`).trim().split('\n').filter(Boolean)
    if (cleanup.remainingOwnedDatabases.length === 0) { admin(`DROP ROLE "${role}";`); cleanup.roleDropped = true }
    else ok = false
  }
  cleanup.completedAt = new Date().toISOString()
  await writeFile(`${out}/${phase}-cleanup.json`, JSON.stringify(cleanup, null, 2) + '\n')
  await writeFile(`${out}/${phase}-results.json`, JSON.stringify({ identity, results, ok, cleanup: `${out}/${phase}-cleanup.json` }, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ complete: true, phase, ok, ownDatabasesRemaining: cleanup.remainingOwnedDatabases ?? [], roleDropped: cleanup.roleDropped }) + '\n')
}
process.exitCode = ok ? 0 : 1
