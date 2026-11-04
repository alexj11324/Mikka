import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runContinuationAcceptance } from './factory-continuation.mjs'

const env = { MIKKA_TEST_ACCOUNT_EMAIL: 'alexjiang20232024@gmail.com', MIKKA_TEST_ACCOUNT_PASSWORD: 'synthetic-test-credential',
  MIKKA_EXPECTED_DEPLOYMENT_SHA: 'a'.repeat(40), MIKKA_EXPECTED_BUILD: 'a'.repeat(40), MIKKA_CONTINUATION_CASES_FILE: '/must-not-read-before-preflight' }
const forbidden = async () => { assert.fail('preflight must not send credentials or make any request') }

test('official continuation rejects unauthorized identities and foreign origins before I/O', async () => {
  await assert.rejects(runContinuationAcceptance({ ...env, MIKKA_TEST_ACCOUNT_EMAIL: 'someone@example.com' }, { fetchImpl: forbidden }), /acceptance_account_required/)
  for (const target of ['https://example.com/mikka', 'https://app.aspectlylabs.com.evil.example/mikka', 'https://app.aspectlylabs.com:8443/mikka',
    'http://app.aspectlylabs.com/mikka', 'https://name:pass@app.aspectlylabs.com/mikka', 'https://app.aspectlylabs.com/mikka?token=x',
    'https://app.aspectlylabs.com/other', 'http://127.0.0.1:3000/mikka', 'not a URL']) {
    await assert.rejects(runContinuationAcceptance({ ...env, MIKKA_ACCEPTANCE_BASE_URL: target }, { fetchImpl: forbidden }), /acceptance_origin_invalid/)
  }
  await assert.rejects(runContinuationAcceptance({ ...env, MIKKA_ACCEPTANCE_BASE_URL: 'http://localhost:3000/mikka', MIKKA_ACCEPTANCE_LOCAL_FIXTURE: '1' }, { fetchImpl: forbidden }), /acceptance_origin_invalid/, 'main-account credentials are never sent to loopback fixtures')
})

async function prepared(t) {
  const directory = await mkdtemp(join(tmpdir(), 'factory-driver-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'cases.json')
  await writeFile(file, JSON.stringify(['claude_code', 'codex'].map(harness => ({ harness, taskId: randomUUID(), threadRunId: randomUUID(),
    artifactTitle: 'fixture.txt', followup: 'fixture request', initialBytes: harness === 'codex' ? 56 : 53,
    expectedBytes: harness === 'codex' ? 77 : 74, initialSha256: '1'.repeat(64), expectedSha256: '2'.repeat(64) }))))
  return { ...env, MIKKA_CONTINUATION_CASES_FILE: file }
}

test('authorized production and explicit Smoke loopback fixtures still pin the build before login', async t => {
  const configured = await prepared(t)
  for (const override of [{}, { MIKKA_TEST_ACCOUNT_EMAIL: 'acceptance+mikka-smoke@example.invalid',
    MIKKA_ACCEPTANCE_BASE_URL: 'http://127.0.0.1:3000/mikka', MIKKA_ACCEPTANCE_LOCAL_FIXTURE: '1' }]) {
    const calls = []
    await assert.rejects(runContinuationAcceptance({ ...configured, ...override }, { fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: init.body }); return Response.json({ build: 'different-build' })
    } }), /deployment changed during acceptance/)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].url.endsWith('/mikka/api/version'))
    assert.equal(calls[0].body, undefined)
  }
})

test('a wrong authenticated identity signs out only the transient session and never reads tasks', async t => {
  const configured = await prepared(t)
  const calls = []
  await assert.rejects(runContinuationAcceptance(configured, { fetchImpl: async (url, init) => {
    const path = new URL(url).pathname; calls.push(path)
    if (path.endsWith('/version')) return Response.json({ build: configured.MIKKA_EXPECTED_BUILD })
    if (path.endsWith('/sign-in/email')) return Response.json({}, { headers: { 'set-cookie': 'synthetic=session; Path=/' } })
    if (path.endsWith('/get-session')) return Response.json({ user: { email: 'different@example.com' } })
    if (path.endsWith('/sign-out')) {
      assert.equal(init.headers.cookie, 'synthetic=session')
      return Response.json({})
    }
    assert.fail('wrong identity must not access Task fixtures')
  } }), /acceptance_session_identity/)
  assert.equal(calls.at(-1), '/mikka/api/auth/sign-out')
  assert.equal(calls.length, 4)
})
