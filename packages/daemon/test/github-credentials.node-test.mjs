import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialFailureMessage, getRunGitHubToken, matchesGitRepository, runGh, RunGitHubCredentialError, RUN_GITHUB_ERROR_MESSAGES } from '../src/agents/github-credentials.mjs'

test('git supplies the owner\'s credential to any HTTPS github.com repository, and to no other host', () => {
  const valid = { protocol: 'https', host: 'github.com', path: 'owner/repo.git' }
  for (const input of [valid, { ...valid, path: 'other-org/another.git' }, { ...valid, path: 'Owner/Repo' }, { ...valid, path: undefined }]) {
    assert.equal(matchesGitRepository(input), true, JSON.stringify(input))
  }
  for (const input of [{ ...valid, host: 'github.com.evil' }, { ...valid, host: 'gitlab.com' }, { ...valid, host: 'api.github.com.attacker.test' }, { ...valid, protocol: 'http' }, { ...valid, protocol: 'ssh' }]) {
    assert.equal(matchesGitRepository(input), false, JSON.stringify(input))
  }
})

test('cache refreshes after fifty minutes and retains a private file outside the checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-github-helper-'))
  const config = { file: join(root, 'config'), endpoint: 'https://mikka.example/api/runs/github-token', runToken: 'synthetic-run' }
  let time = Date.parse('2026-10-30T12:00:00Z'), requests = 0
  const fetcher = async (url, init) => {
    assert.equal(url, config.endpoint)
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.authorization, 'Bearer synthetic-run')
    return Response.json({ token: `synthetic-user-${++requests}`, expiresAt: new Date(time + 3600_000).toISOString() })
  }
  const deps = { fetcher, now: () => time }
  assert.equal(await getRunGitHubToken(config, deps), 'synthetic-user-1')
  time += 49 * 60_000
  assert.equal(await getRunGitHubToken(config, deps), 'synthetic-user-1')
  // A new long CI watch must not start with only eleven minutes left.
  assert.equal(await getRunGitHubToken(config, { ...deps, minValidityMs: 41 * 60_000 }), 'synthetic-user-2')
  time += 60_000
  assert.equal(await getRunGitHubToken(config, deps), 'synthetic-user-2')
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

test('a refused exchange names the reason in English and Chinese, from known codes only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-gh-'))
  const config = { file: join(root, 'config'), endpoint: 'https://mikka.example/api/runs/github-token', runToken: 'synthetic-run-token' }
  const refused = (body, status = 409) => ({ fetcher: async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }) })
  const error = await getRunGitHubToken(config, refused({ error: 'githubNotConnected' })).catch(caught => caught)
  assert.ok(error instanceof RunGitHubCredentialError)
  assert.equal(error.code, 'githubNotConnected')
  assert.equal(credentialFailureMessage(error), `Mikka: ${RUN_GITHUB_ERROR_MESSAGES.githubNotConnected[0]}\nMikka：${RUN_GITHUB_ERROR_MESSAGES.githubNotConnected[1]}\n`)
  assert.match(credentialFailureMessage(error), /Plugins › GitHub/)
  for (const [code, message] of Object.entries(RUN_GITHUB_ERROR_MESSAGES)) {
    const failed = await getRunGitHubToken(config, refused({ error: code }, 502)).catch(caught => caught)
    assert.equal(failed.code, code)
    assert.ok(credentialFailureMessage(failed).includes(message[0]) && credentialFailureMessage(failed).includes(message[1]))
  }
  // An unknown code, a provider body or a non-JSON reply is never shown.
  for (const body of [{ error: 'synthetic-provider-detail' }, { error: { token: 'synthetic-leak' } }, 'synthetic-html <b>error</b>']) {
    const failed = await getRunGitHubToken(config, refused(body, 502)).catch(caught => caught)
    assert.equal(failed.code, null)
    assert.equal(credentialFailureMessage(failed), 'Mikka GitHub credentials or CI status unavailable.\n')
  }
  assert.equal(credentialFailureMessage(new Error('synthetic-other-failure')), 'Mikka GitHub credentials or CI status unavailable.\n')
})
