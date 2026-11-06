// Owns an isolated local acceptance process tree. The caller supplies only an
// already-owned, fresh loopback mikka_e2e database URL; no external keys needed.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
const database = new URL(process.env.E2E_DATABASE_URL ?? '')
assert.ok(['postgres:', 'postgresql:'].includes(database.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
  && database.pathname === '/mikka_e2e' && !database.search && !database.hash, 'FRESH_OWNED_LOOPBACK_MIKKA_E2E_REQUIRED')
assert.ok(!process.env.VERCEL && !process.env.VERCEL_ENV, 'DEPLOYED_ENVIRONMENT_FORBIDDEN')
assert.ok(!['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'E2B_API_KEY', 'COMPOSIO_API_KEY', 'POSTHOG_SECRET_KEY', 'RESEND_API_KEY', 'ZEROCAT_API_KEY']
  .some(key => Boolean(process.env[key])), 'LIVE_SERVICE_CREDENTIALS_FORBIDDEN')
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const directory = resolve(root, '.cache/trace-acceptance', `${revision.slice(0, 12)}-${randomUUID()}`)
await mkdir(directory, { recursive: true, mode: 0o700 })
const privateLogDirectory = join(directory, 'private-logs')
await mkdir(privateLogDirectory, { recursive: true, mode: 0o700 })
const env = { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'development', CI: '', GITHUB_ACTIONS: '', MIKKA_DEV_SKIP_ENV_FILES: '1',
  E2E_DATABASE_URL: database.href, MIKKA_DATABASE_URL: database.href, DATABASE_URL: database.href,
  MIKKA_LOCAL_TEST_ACCOUNTS: '1', MIKKA_TEST_MODE: '1', MIKKA_MVP_E2E: '1',
  BETTER_AUTH_URL: 'http://localhost:3100', E2E_BASE_URL: 'http://localhost:3100',
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'),
  MIKKA_TEST_DEPLOYMENT_SHA: revision, MIKKA_TEST_ENVIRONMENT_FILE: join(directory, 'environment.json'),
  MIKKA_TRACE_EVIDENCE_DIR: directory, MIKKA_MVP_RESOURCE_INDEX: join(directory, 'retained-resources.jsonl'),
  NEXT_PUBLIC_POSTHOG_KEY: 'phc_trace_fixture_1512', MIKKA_TRACE_SAMPLE_RATE: '1',
  MIKKA_TRACE_ENDPOINT: 'http://127.0.0.1:3196/i/v1/traces', AI_GATEWAY_API_KEY: '',
}
async function run(label, args, additions = {}) {
  console.info(`trace-acceptance ${label}`)
  const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...additions }, stdio: label === 'chain' ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
  const log = label === 'chain' ? null : createWriteStream(join(privateLogDirectory, `${label}.log`), { flags: 'wx', mode: 0o600 })
  let bytes = 0, logFailed = false
  log?.on('error', () => { logFailed = true })
  const capture = chunk => {
    if (!log || logFailed) return
    const kept = chunk.subarray(0, Math.max(0, 8_000_000 - bytes)); bytes += kept.length
    if (kept.length) log.write(kept)
  }
  child.stdout?.on('data', capture); child.stderr?.on('data', capture)
  child.once('close', () => log?.end())
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  assert.equal(code, 0, `TRACE_${label.toUpperCase()}_FAILED`)
}
try {
  await run('schema', ['--import', 'tsx', 'scripts/setup-e2e-db.mjs'])
  await run('bootstrap', ['--import', 'tsx', 'scripts/test-accounts/bootstrap.mjs', '--output', env.MIKKA_TEST_ENVIRONMENT_FILE])
  await run('chain', ['--import', 'tsx', '--import', pathToFileURL(join(root, 'tests/mvp/trace-preload.mjs')).href, 'tests/mvp/trace-chain.mjs'],
    { AI_GATEWAY_API_KEY: 'mvp-synthetic-decisions' })
} catch (error) {
  console.error(JSON.stringify({ traceAcceptance: 'failed', code: /^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'TRACE_RUNNER_FAILED', revision,
    privateLogDirectory }))
  process.exitCode = 1
}
