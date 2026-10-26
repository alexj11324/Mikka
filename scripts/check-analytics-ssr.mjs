// Built Next HTTP regression. Synthetic analytics is enabled; no browser executes
// instrumentation, so this test sends no events or user data to PostHog.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, readdir } from 'node:fs/promises'

assert.equal(process.env.CI, 'true', 'Requires an isolated CI environment')
const key = 'phc_synthetic_ssr_regression'
assert.equal(process.env.NEXT_PUBLIC_POSTHOG_KEY, key)
const database = new URL(process.env.E2E_DATABASE_URL)
assert.ok(['127.0.0.1', 'localhost'].includes(database.hostname))
assert.equal(database.pathname, '/mikka_e2e')
for (const name of ['MIKKA_DATABASE_URL', 'DATABASE_URL']) assert.equal(process.env[name], database.href)
const chunks = await readdir('.next/static/chunks')
let enabledBuild = false
for (const file of chunks.filter(name => name.endsWith('.js'))) {
  if ((await readFile(`.next/static/chunks/${file}`, 'utf8')).includes(key)) enabledBuild = true
}
assert.ok(enabledBuild, 'Build must include the enabled synthetic analytics configuration')
const port = 3186
const origin = `http://localhost:${port}`
const env = { PATH: process.env.PATH, NODE_ENV: 'production', CI: 'true', NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_POSTHOG_KEY: key, BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: 'synthetic-ssr-regression-secret-not-a-real-credential',
  MIKKA_DATABASE_URL: database.href, DATABASE_URL: database.href }
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', 'localhost', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''
child.stdout.on('data', chunk => { logs += chunk })
child.stderr.on('data', chunk => { logs += chunk })
const exited = once(child, 'exit')
try {
  let ready = false
  for (let i = 0; i < 120; i++) {
    assert.equal(child.exitCode, null, 'Next must remain running')
    if (logs.includes('Ready in')) { ready = true; break }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(ready, 'Next startup timed out')
  for (const path of ['/mikka', '/mikka/sign-in', '/mikka/en/sign-in']) {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(30_000) })
    assert.equal(response.status, 200, `${path} must render with analytics enabled`)
    assert.match(await response.text(), /<html/)
    console.log(JSON.stringify({ path, status: response.status, analytics: 'synthetic-enabled' }))
  }
  assert.doesNotMatch(logs, /Cannot read properties of null|Invalid hook call/)
} finally {
  child.kill('SIGTERM')
  await exited
}
