import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const phase = process.argv[2]
const sha = process.argv[3]
assert.match(sha ?? '', /^[0-9a-f]{40}$/)
const root = '/home/agent/workspace/mikka-computer-events-integrated-2ab'
const name = 'mikka_c_' + sha.slice(0, 8) + '_e2e'
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sha)
assert.equal(Number(process.versions.node.split('.')[0]), 24)
const url = new URL(process.env.E2E_DATABASE_URL)
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname))
const adminUrl = new URL(url); adminUrl.pathname = '/postgres'
url.pathname = '/' + name
const env = { ...process.env, E2E_DATABASE_URL: url.href, MIKKA_DATABASE_URL: url.href, DATABASE_URL: url.href,
  BETTER_AUTH_URL: 'http://localhost:3491', E2E_BASE_URL: 'http://localhost:3491',
  MIKKA_LOCAL_TEST_ACCOUNTS: '1', MIKKA_CREDENTIAL_HARNESS: '1', MIKKA_TEST_DEPLOYMENT_SHA: sha,
  MIKKA_TEST_ENVIRONMENT_FILE: root + '/.cache/computer-events-environment-b127.json', DISPLAY: process.env.DISPLAY }
delete env.ORVILO_DATABASE_URL
for (const key of ['AI_GATEWAY_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'COMPOSIO_API_KEY', 'E2B_API_KEY',
  'EXPO_ACCESS_TOKEN', 'POSTHOG_SECRET_KEY', 'RESEND_API_KEY', 'DEEPSEEK_API_KEY', 'DOCKER_ID', 'DOCKER_PAT', 'DEVICE_GATEWAY_URL', 'DEVICE_GATEWAY_PUSH_SECRET']) delete env[key]
const log = openSync('/tmp/mikka-c-b127-runtime.log', 'a', 0o600)
async function command(args) {
  const child = spawn(args[0], args.slice(1), { cwd: root, env, stdio: ['ignore', log, log] })
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  if (code !== 0) throw new Error('command_failed:' + args[0] + ':' + code)
}
try {
  if (['build', 'rebuild'].includes(phase)) {
    if (phase === 'build') {
      const require = createRequire(root + '/package.json')
      const { Pool } = require('pg')
      const db = new Pool({ connectionString: adminUrl.href, max: 1 })
      try {
        assert.equal((await db.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 0, 'fresh database required')
        const role = decodeURIComponent(url.username)
        assert.match(role, /^[a-z_][a-z0-9_]*$/)
        await db.query('CREATE DATABASE "' + name + '" OWNER "' + role + '"')
      } finally { await db.end() }
      await mkdir(root + '/.cache', { recursive: true })
      await command(['node', '--import', 'tsx', 'scripts/setup-e2e-db.mjs'])
      await command(['node', 'scripts/test-accounts/bootstrap.mjs', '--output', env.MIKKA_TEST_ENVIRONMENT_FILE])
    } else {
      const descriptor = JSON.parse(await readFile(env.MIKKA_TEST_ENVIRONMENT_FILE, 'utf8'))
      assert.equal(descriptor.deploymentSha, sha)
      assert.equal(descriptor.origin, env.BETTER_AUTH_URL)
      assert.equal(descriptor.database.name, name)
    }
    await command(['corepack', 'pnpm', 'build'])
    const serverLog = openSync('/tmp/mikka-c-b127-server.log', 'a', 0o600)
    const child = spawn('node', ['node_modules/next/dist/bin/next', 'start', '--hostname', 'localhost', '--port', '3491'],
      { cwd: root, env, detached: true, stdio: ['ignore', serverLog, serverLog] })
    child.unref()
    await writeFile('/tmp/mikka-c-b127-server.pid', String(child.pid), { mode: 0o600 })
    closeSync(serverLog)
    console.log(JSON.stringify({ status: 'built_and_server_started', sha, origin: env.BETTER_AUTH_URL, database: name, pid: child.pid }))
  } else if (phase === 'capture') {
    const version = await fetch(env.BETTER_AUTH_URL + '/mikka/api/version')
    assert.equal(version.status, 200)
    assert.equal((await version.json()).build, sha)
    await command(['node', '--experimental-test-module-mocks', '--import', './scripts/server-test.mjs', '--import', 'tsx', '.cache/c-preview-capture.mjs'])
    const manifest = JSON.parse(await readFile('/tmp/mikka-c-b127-screenshots/manifest.json', 'utf8'))
    console.log(JSON.stringify({ status: 'captured', sha, captures: manifest.captures.length, finishedAt: manifest.finishedAt }))
  } else throw new Error('phase_required')
} finally { closeSync(log) }
