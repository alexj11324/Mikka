// Local-only visual acceptance: ephemeral generated credentials stay in this
// process environment and the existing private TestPool evidence inventory.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
const root = '/vercel/sandbox/mikka-pending-live'
const sha = process.env.MIKKA_PENDING_VISUAL_SHA
assert.match(sha ?? '', /^[0-9a-f]{40}$/)
const require = createRequire(root + '/package.json')
const { Pool } = require('pg')
const password = randomBytes(32).toString('hex')
const url = new URL('postgresql://mikka_test@127.0.0.1:5432/mikka_e2e')
const db = new Pool({ connectionString: url.href, max: 1 })
try {
  assert.equal((await db.query('SELECT current_user AS name')).rows[0].name, 'mikka_test')
  const statement = (await db.query("SELECT format('ALTER ROLE %I PASSWORD %L', current_user, $1::text) AS sql", [password])).rows[0].sql
  await db.query(statement)
} finally { await db.end() }
url.password = password
const env = { ...process.env, MIKKA_PENDING_REPO: root, E2E_DATABASE_URL: url.href, BETTER_AUTH_SECRET: randomBytes(32).toString('hex') }
for (const key of ['ORVILO_DATABASE_URL','AI_GATEWAY_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','COMPOSIO_API_KEY','E2B_API_KEY','EXPO_ACCESS_TOKEN','POSTHOG_SECRET_KEY','NEXT_PUBLIC_POSTHOG_KEY','RESEND_API_KEY','DEEPSEEK_API_KEY','DEVICE_GATEWAY_URL','DEVICE_GATEWAY_PUSH_SECRET']) delete env[key]
async function phase(name) {
  const child = spawn('node', ['/vercel/sandbox/mikka-pending-runtime.mjs', name], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] })
  const exit = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  assert.equal(exit, 0, 'visual phase failed: ' + name)
}
try {
  await phase('prepare')
  let ready = false
  for (let i = 0; i < 120; i++) {
    const response = await fetch('http://localhost:3352/mikka/api/version', { signal: AbortSignal.timeout(1_000) }).catch(() => null)
    if (response?.ok) { assert.equal((await response.json()).build, sha); ready = true; break }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.ok(ready, 'exact local build did not become ready')
  await phase('capture')
} catch (error) {
  // Do not print database statements, credentials, environment or response bodies.
  console.error(JSON.stringify({ status: 'visual_failed', name: error?.name ?? 'Error', code: error?.code ?? null }))
  process.exitCode = 1
}
