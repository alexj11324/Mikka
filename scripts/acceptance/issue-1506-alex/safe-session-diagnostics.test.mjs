import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALEX_OWNER_ID, alexSession } from '../issue-1506-readonly/alex-session.mjs'
import { runToolStop } from './coordinator-tool-stop.mjs'
import { runGroupStop } from './group-stop.mjs'
import { fakeSession, fixtureReceipt } from './fixture-support.mjs'

const PRIVATE = 'private-body-cookie-header-token-never-report'
const credentials = { ACME_DEMO_EMAIL: 'fixture@example.invalid', ACME_DEMO_PASSWORD: PRIVATE }
function failingFetch({ cookie = false, failedSignout = false } = {}) {
  const calls = []
  return { calls, async fetchImpl(url) {
    const path = new URL(url).pathname
    calls.push(path)
    if (path.endsWith('/sign-in/email')) return Response.json(cookie ? { ok: true } : { error: PRIVATE }, {
      status: cookie ? 200 : 503, headers: { ...(cookie ? { 'set-cookie': 'session=' + PRIVATE + '; HttpOnly' } : {}), 'x-vercel-id': PRIVATE, 'x-private': PRIVATE } })
    if (path.endsWith('/get-session')) return Response.json({ error: PRIVATE, body: PRIVATE }, { status: 401, headers: { 'x-private': PRIVATE } })
    if (path.endsWith('/sign-out')) return Response.json(failedSignout ? { error: PRIVATE } : { ok: true }, { status: 200 })
    assert.fail('unexpected fake request')
  } }
}
const clean = value => assert.equal(JSON.stringify(value).includes(PRIVATE), false)
for (const cookie of [false, true]) {
  test('actual alexSession exposes safe pre-callback failure and cleanup, cookie=' + cookie, async () => {
    const f = failingFetch({ cookie })
    let diagnostics, entered = false
    await assert.rejects(alexSession(() => { entered = true }, {
      env: credentials, expectedSha: null, fetchImpl: f.fetchImpl, onSession: value => { diagnostics = value },
    }), /acceptance_http_failed/)
    assert.equal(entered, false)
    assert.ok(diagnostics)
    assert.deepEqual(diagnostics.requests.map(({ path, method, status }) => ({ path, method, status })), cookie ? [
      { path: '/mikka/api/auth/sign-in/email', method: 'POST', status: 200 },
      { path: '/mikka/api/auth/get-session', method: 'GET', status: 401 },
      { path: '/mikka/api/auth/sign-out', method: 'POST', status: 200 },
    ] : [{ path: '/mikka/api/auth/sign-in/email', method: 'POST', status: 503 }])
    assert.deepEqual(diagnostics.signOut, { attempted: cookie, succeeded: cookie })
    assert.equal(f.calls.length, cookie ? 3 : 1, 'one attempt, no automatic retries')
    clean(diagnostics)
  })
}

for (const kind of ['tool', 'group']) for (const failedSignout of [false, true]) {
  test(kind + ' reports session failure before callback and actual signout=' + !failedSignout, async () => {
    const f = failingFetch({ cookie: true, failedSignout })
    const base = fakeSession({ readyBots: true }).options
    const options = { ...base, env: { ...base.env, MIKKA_FIXTURE_KIND: 'luna', MIKKA_STOP_CASE: 'during_tool' },
      fixtureReceipt: fixtureReceipt(), checkpoint: false,
      sessionProvider: (work, input) => alexSession(work, { ...input, env: credentials, fetchImpl: f.fetchImpl }) }
    const report = await (kind === 'tool' ? runToolStop : runGroupStop)(options)
    assert.equal(report.status, 'failed')
    assert.equal(report.error, 'acceptance_http_failed')
    assert.equal(report.messageSendAttempts, 0)
    assert.equal(report.stop.requested, false)
    assert.deepEqual(report.requests.map(row => [row.path, row.method, row.status]), [
      ['/mikka/api/auth/sign-in/email', 'POST', 200],
      ['/mikka/api/auth/get-session', 'GET', 401],
      ['/mikka/api/auth/sign-out', 'POST', 200],
    ])
    assert.equal(report.signedOut, !failedSignout)
    assert.deepEqual(report.sessionSignOut, { attempted: true, succeeded: !failedSignout })
    clean(report)
  })
}

for (const key of ['luna', undefined]) {
  test('early tool failure checkpoint uses validated fixture ' + (key ?? 'unselected'), async () => {
    const cwd = process.cwd(), directory = mkdtempSync(join(tmpdir(), 'mikka-session-diagnostics-'))
    try {
      process.chdir(directory)
      const base = fakeSession({ readyBots: true }).options
      const f = failingFetch()
      const env = { ...base.env, MIKKA_STOP_CASE: 'during_tool' }
      if (key) env.MIKKA_FIXTURE_KIND = key
      else delete env.MIKKA_FIXTURE_KIND
      await runToolStop({ ...base, env, checkpoint: true,
        sessionProvider: (work, input) => alexSession(work, { ...input, env: credentials, fetchImpl: f.fetchImpl }) })
      const files = readdirSync('issue-1506-alex-report')
      assert.equal(files.length, 1)
      assert.ok(files[0].startsWith('coordinator-tool-stop-' + (key ?? 'unselected') + '-during_tool-'))
      clean(JSON.parse(readFileSync(join('issue-1506-alex-report', files[0]), 'utf8')))
    } finally { process.chdir(cwd); rmSync(directory, { recursive: true, force: true }) }
  })
}

test('startup metadata is bounded and strips query, body, cookie and response headers', async () => {
  let diagnostics
  await alexSession(async session => {
    for (let i = 0; i < 20; i++) await session.request('/api/version?token=' + PRIVATE)
  }, { env: credentials, expectedSha: null, onSession: value => { diagnostics = value },
    fetchImpl: async url => {
      const path = new URL(url).pathname
      if (path.endsWith('/get-session')) return Response.json({ user: { id: ALEX_OWNER_ID, email: credentials.ACME_DEMO_EMAIL } })
      return Response.json({ ok: true, build: 'a'.repeat(40), private: PRIVATE }, {
        headers: { 'set-cookie': 'session=' + PRIVATE + '; HttpOnly', 'x-private': PRIVATE, 'x-vercel-id': PRIVATE } })
    } })
  assert.equal(diagnostics.requests.length, 16)
  assert.equal(diagnostics.requests.at(-1).path, '/mikka/api/auth/sign-out')
  assert.deepEqual(diagnostics.signOut, { attempted: true, succeeded: true })
  for (const row of diagnostics.requests) assert.deepEqual(Object.keys(row).sort(), ['headersMs', 'method', 'path', 'status'])
  clean(diagnostics)
})
