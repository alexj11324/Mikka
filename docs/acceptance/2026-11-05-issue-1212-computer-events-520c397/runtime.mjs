// Isolated production build + normal TestAccountPool. All generated credentials
// stay in this process/child environment and the harness's private inventory.
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const root = '/vercel/sandbox/mikka-capture-c520-egress'
const sha = '520c397e2f58cdc69dd5c6d75f6e8d83ffe2b103'
const tree = 'c342a69139192ce077a7738707aec788579c51e1'
const output = '/vercel/acceptance/capture-c520-egress'
const capture = '/vercel/acceptance/capture-c520-egress/capture.mjs'
const origin = 'http://localhost:3387'
const descriptor = '/vercel/acceptance/private-c520-environment/descriptor.json'
const { Pool } = createRequire(root + '/package.json')('pg')
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sha)
assert.equal(execFileSync('git', ['write-tree'], { cwd: root, encoding: 'utf8' }).trim(), tree)
execFileSync('git', ['diff', '--quiet', 'HEAD'], { cwd: root })
assert.deepEqual(execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean), [])
assert.equal(Number(process.versions.node.split('.')[0]), 24)
assert.equal(Boolean(process.env.CI || process.env.VERCEL_ENV || process.env.VERCEL === '1'), false)
await mkdir(output, { recursive: true, mode: 0o700 })
const runId = randomBytes(5).toString('hex'), role = 'mikka_c520_ui_' + runId, database = role + '_e2e'
const password = randomBytes(32).toString('hex')
const databaseURL = new URL('postgresql://127.0.0.1:5432/' + database)
databaseURL.username = role; databaseURL.password = password
const env = { ...process.env, BETTER_AUTH_URL: origin, E2E_BASE_URL: origin,
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), MIKKA_LOCAL_TEST_ACCOUNTS: '1', MIKKA_CREDENTIAL_HARNESS: '1', DISPLAY: ':188',
  MIKKA_TEST_DEPLOYMENT_SHA: sha, MIKKA_TEST_ENVIRONMENT_FILE: descriptor, NEXT_TELEMETRY_DISABLED: '1' }
for (const key of ['DATABASE_URL', 'MIKKA_DATABASE_URL', 'E2E_DATABASE_URL', 'ORVILO_DATABASE_URL', 'WORKSPACE_DATABASE_URL', 'MARKETPLACE_DATABASE_URL']) env[key] = databaseURL.href
for (const key of ['AI_GATEWAY_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'COMPOSIO_API_KEY', 'E2B_API_KEY', 'EXPO_ACCESS_TOKEN', 'POSTHOG_SECRET_KEY', 'NEXT_PUBLIC_POSTHOG_KEY', 'RESEND_API_KEY', 'DEEPSEEK_API_KEY', 'DEVICE_GATEWAY_URL', 'DEVICE_GATEWAY_PUSH_SECRET']) delete env[key]
const manifest = { sha, tree, database, role, origin, descriptor, startedAt: new Date().toISOString(),
  captureScriptSha256: createHash('sha256').update(await readFile(capture)).digest('hex'), commands: [], status: 'running' }
const save = () => writeFile(output + '/runtime-manifest.json', JSON.stringify(manifest, null, 2), { mode: 0o600 })
const admin = new Pool({ connectionString: 'postgresql://mikka_test@127.0.0.1:5432/mikka_e2e', max: 1 })
let ownedRole = false, ownedDatabase = false, server, display, active, interrupted = false
function terminate(child) {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; terminate(active) })
async function command(name, args) {
  assert.equal(interrupted, false, 'interrupted before next phase')
  const log = output + '/' + name + '.log', startedAt = new Date().toISOString(), fd = openSync(log, 'a', 0o600)
  const child = spawn(args[0], args.slice(1), { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] }); active = child
  let exitCode
  try { exitCode = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }) }
  finally { closeSync(fd); if (active === child) active = null }
  manifest.commands.push({ name, startedAt, finishedAt: new Date().toISOString(), exitCode, log }); await save()
  assert.equal(interrupted, false, 'interrupted during phase')
  assert.equal(exitCode, 0, 'isolated phase failed: ' + name)
}
try {
  assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount, 0)
  assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount, 0)
  await admin.query('CREATE ROLE "' + role + '" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD \'' + password + '\''); ownedRole = true
  await admin.query('CREATE DATABASE "' + database + '" OWNER "' + role + '" TEMPLATE template0'); ownedDatabase = true
  await save(); await mkdir(root + '/.cache', { recursive: true, mode: 0o700 })
  await command('setup', ['node', '--import', 'tsx', 'scripts/setup-e2e-db.mjs'])
  await command('bootstrap', ['node', 'scripts/test-accounts/bootstrap.mjs', '--output', descriptor])
  await command('build', ['npx', '--yes', 'pnpm@10.34.3', 'build'])
  execFileSync('git', ['diff', '--quiet', 'HEAD'], { cwd: root })
  const fd = openSync(output + '/server.log', 'a', 0o600)
  server = spawn('node', ['node_modules/next/dist/bin/next', 'start', '--hostname', 'localhost', '--port', '3387'], { cwd: root, env, detached: true, stdio: ['ignore', fd, fd] })
  closeSync(fd); manifest.serverPid = server.pid; await save()
  let ready = false
  for (let i = 0; i < 60 && !interrupted; i++) {
    if ((server.exitCode !== null || server.signalCode !== null)) break
    try {
      const response = await fetch(origin + '/mikka/api/version', { signal: AbortSignal.timeout(3000) })
      if (response.status === 200) { assert.equal((await response.json()).build, sha); ready = true; break }
    } catch (error) { if (error?.code === 'ERR_ASSERTION') throw error }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert.ok(ready, 'own exact build must be ready')
  manifest.versionVerifiedAt = new Date().toISOString(); await save()
  assert.equal((await import('node:fs')).existsSync('/tmp/.X11-unix/X188'), false, 'own display must be unused')
  const displayFd = openSync(output + '/xvfb.log', 'a', 0o600)
  display = spawn('Xvfb', [':188', '-screen', '0', '1600x1200x24', '-nolisten', 'tcp'], { env, detached: true, stdio: ['ignore', displayFd, displayFd] })
  closeSync(displayFd); manifest.displayPid = display.pid; await save()
  for (let i = 0; i < 50 && !(await import('node:fs')).existsSync('/tmp/.X11-unix/X188'); i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal((await import('node:fs')).existsSync('/tmp/.X11-unix/X188'), true, 'own Xvfb must be ready')
  await command('capture', ['node', '--import', './scripts/server-test.mjs', '--import', 'tsx', capture])
  manifest.status = 'completed'
} catch (error) {
  manifest.status = interrupted ? 'interrupted' : 'failed'
  manifest.errorClass = error?.name ?? 'unknown'
  manifest.errorCode = typeof error?.code === 'string' ? error.code : null
  process.exitCode = 1
} finally {
  terminate(active); terminate(server)
  if (server && server.exitCode === null && server.signalCode === null) {
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))])
    if (server.exitCode === null && server.signalCode === null) {
      try { process.kill(-server.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await new Promise(resolve => server.once('exit', resolve))
    }
  }
  terminate(display)
  if (display && display.exitCode === null && display.signalCode === null) await Promise.race([new Promise(resolve => display.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))])
  if (ownedDatabase) {
    const connections = (await admin.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'", [database])).rows
    manifest.preDropConnections = connections
    assert.deepEqual(connections, [], 'only drop own DB after clients exit')
    await admin.query('DROP DATABASE "' + database + '"')
  }
  if (ownedRole) await admin.query('DROP ROLE "' + role + '"')
  manifest.cleanup = { databaseAbsent: (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount === 0,
    roleAbsent: (await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount === 0, serverExited: !server || server.exitCode !== null || server.signalCode !== null, displayExited: !display || display.exitCode !== null || display.signalCode !== null, at: new Date().toISOString() }
  await admin.end(); manifest.finishedAt = new Date().toISOString(); await save()
  console.log(JSON.stringify({ status: manifest.status, sha, tree, output, cleanup: manifest.cleanup }))
}
