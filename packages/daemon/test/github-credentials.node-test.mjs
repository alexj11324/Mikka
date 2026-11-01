import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRunGitHubToken, matchesGitRepository, RunGitHubCredentialsError, runGh } from '../src/agents/github-credentials.mjs'

test('git supplies a token only to the exact HTTPS GitHub repository', () => {
  const valid = { protocol: 'https', host: 'github.com', path: 'owner/repo.git' }
  assert.equal(matchesGitRepository(valid, 'owner/repo'), true)
  for (const input of [{ ...valid, host: 'github.com.evil' }, { ...valid, protocol: 'http' }, { ...valid, path: 'other/repo.git' }, { ...valid, path: undefined }]) {
    assert.equal(matchesGitRepository(input, 'owner/repo'), false)
  }
})

test('cache refreshes after fifty minutes and retains a private file outside the checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-github-helper-'))
  const config = { file: join(root, 'config'), endpoint: 'https://mikka.example/api/runs/github-token', repository: 'owner/repo', runToken: 'synthetic-run' }
  let time = Date.parse('2026-10-30T12:00:00Z'), requests = 0
  const fetcher = async (url, init) => {
    assert.equal(url, config.endpoint)
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.authorization, 'Bearer synthetic-run')
    return Response.json({ token: `synthetic-installation-${++requests}`, repository: config.repository, expiresAt: new Date(time + 3600_000).toISOString() })
  }
  const deps = { fetcher, now: () => time }
  assert.equal(await getRunGitHubToken(config, deps), 'synthetic-installation-1')
  time += 49 * 60_000
  assert.equal(await getRunGitHubToken(config, deps), 'synthetic-installation-1')
  // A new long CI watch must not start with only eleven minutes left.
  assert.equal(await getRunGitHubToken(config, { ...deps, minValidityMs: 41 * 60_000 }), 'synthetic-installation-2')
  time += 60_000
  assert.equal(await getRunGitHubToken(config, deps), 'synthetic-installation-2')
  assert.equal((await stat(`${config.file}.cache`)).mode & 0o077, 0)
  assert.doesNotMatch(await readFile(`${config.file}.cache`, 'utf8'), /synthetic-run/)
})

test('a failed refresh never reuses the expired token or discloses a response body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-github-denied-'))
  await assert.rejects(getRunGitHubToken({ file: join(root, 'config') }, { fetcher: async () => new Response('private-provider-error', { status: 403 }) }), /Run GitHub credentials unavailable/)
})

test('CI watch renews its token before expiry and preserves native gh watch flags', async () => {
  const args = ['pr', 'checks', '12', '--repo', 'owner/repo', '--watch', '--required', '--interval', '3']
  const calls = [], validities = []
  const code = await runGh({}, args, {
    token: async minValidity => { validities.push(minValidity); return `synthetic-${validities.length}` },
    invoke: async (actual, token, timeoutMs) => {
      calls.push({ args: actual, token, timeoutMs })
      return calls.length === 1 ? { code: 1, timedOut: true } : { code: 0, timedOut: false }
    },
  })
  assert.equal(code, 0)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.args), [args, args])
  assert.deepEqual(calls.map(call => call.token), ['synthetic-1', 'synthetic-2'])
  assert.equal(calls[0].timeoutMs, 40 * 60_000)
  assert.ok(validities.every(validity => validity > calls[0].timeoutMs))
})

test('failed, pending and malformed CLI invocation exits are never converted to success', async () => {
  for (const code of [1, 8, 2, 127]) {
    let calls = 0
    assert.equal(await runGh({}, ['pr', 'checks', '--watch', '--fail-fast'], {
      token: async () => 'synthetic', invoke: async () => { calls++; return { code, timedOut: false } },
    }), code)
    assert.equal(calls, 1)
  }
})

test('normal gh commands run once without watch timers', async () => {
  const args = ['pr', 'create', '--draft']
  let calls = 0
  assert.equal(await runGh({}, args, {
    token: async () => 'synthetic', invoke: async (actual, _token, timeout) => {
      calls++; assert.deepEqual(actual, args); assert.equal(timeout, undefined); return { code: 0 }
    },
  }), 0)
  assert.equal(calls, 1)
})

test('a refused token says the status and the fixed code, and drops anything else', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'mikka-github-')), 'token')
  const config = { file, endpoint: 'https://mikka.example/token', runToken: 'run-token', repository: 'owner/repo' }
  const refuse = body => async () => Response.json(body, { status: 502 })
  await assert.rejects(getRunGitHubToken(config, { fetcher: refuse({ reason: 'github_permission_required' }) }), error => error instanceof RunGitHubCredentialsError && error.detail === '502 github_permission_required')
  await assert.rejects(getRunGitHubToken(config, { fetcher: refuse({ reason: 'private body: secret' }) }), error => error.detail === '502')
  await assert.rejects(getRunGitHubToken(config, { fetcher: async () => new Response('not json', { status: 502 }) }), error => error.detail === '502')
})
