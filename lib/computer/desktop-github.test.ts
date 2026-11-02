import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DESKTOP_GITHUB_HELPER_SOURCE, desktopGitHubConfig, installDesktopGitHub } from './desktop-github'
import { SNAPSHOT_CREDENTIAL_GLOBS } from '../../packages/daemon/src/credential-globs'

const deviceId = '10000000-0000-4000-8000-000000000001'
const credential = 'orv_' + 'a'.repeat(43)
const token = 'ghu_' + 'E'.repeat(36)

function run(script: string, args: string[], input: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const child = execFile(process.execPath, [script, ...args], { env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', ...env } }, (error: Error | null, stdout: string, stderr: string) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }))
    child.stdin!.end(input)
  })
}

test('the desktop helper gives git and gh the owner credential for github.com only, asking with the device credential', async () => {
  const seen: { authorization?: string; url?: string }[] = []
  let answer: { status: number; body: unknown } = { status: 200, body: { token, expiresAt: new Date(Date.now() + 3600_000).toISOString() } }
  const server = createServer((request, response) => {
    seen.push({ authorization: request.headers.authorization, url: request.url })
    response.statusCode = answer.status
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(answer.body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const dir = mkdtempSync(join(tmpdir(), 'mikka-desktop-github-'))
    const script = join(dir, 'credential.mjs')
    writeFileSync(script, DESKTOP_GITHUB_HELPER_SOURCE, { mode: 0o600 })
    const deviceFile = join(dir, 'device.json')
    writeFileSync(deviceFile, JSON.stringify({ deviceId, credential }), { mode: 0o600 })
    const gh = join(dir, 'fake-gh')
    writeFileSync(gh, '#!/bin/sh\nprintf "%s|%s|%s" "$GH_HOST" "$GH_TOKEN" "$*"\n'); chmodSync(gh, 0o700)
    const config = { ...desktopGitHubConfig(`http://127.0.0.1:${port}/mikka/`, deviceId), deviceFile, gh }
    assert.equal(config.endpoint, `http://127.0.0.1:${port}/mikka/v1/devices/${deviceId}/github-token`)
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config))

    const github = await run(script, ['git', 'get'], 'protocol=https\nhost=github.com\npath=any-org/any-repo.git\n\n')
    assert.equal(github.code, 0, github.stderr)
    assert.equal(github.stdout, `username=x-access-token\npassword=${token}\n\n`)
    assert.deepEqual(seen, [{ authorization: `Bearer ${credential}`, url: `/mikka/v1/devices/${deviceId}/github-token` }])
    assert.equal(statSync(join(dir, 'token.json')).mode & 0o077, 0, 'the cache is private')
    // Cached: no second request; other hosts get nothing.
    assert.equal((await run(script, ['git', 'get'], 'protocol=https\nhost=github.com\npath=o/r.git\n\n')).stdout.includes(token), true)
    for (const other of ['protocol=https\nhost=gitlab.com\n\n', 'protocol=http\nhost=github.com\n\n', 'protocol=https\nhost=github.com.evil.test\n\n'])
      assert.equal((await run(script, ['git', 'get'], other)).stdout, '')
    assert.equal(seen.length, 1)

    assert.equal((await run(script, ['gh', 'pr', 'list'], '')).stdout, `github.com|${token}|pr list`)
    assert.equal((await run(script, ['gh', 'pr', 'list'], '', { GH_TOKEN: 'run-own' })).stdout, `|run-own|pr list`, 'a run\'s own credential is kept as given')

    // A refusal names the code only, never a body.
    writeFileSync(join(dir, 'token.json'), '{}', { mode: 0o600 })
    answer = { status: 409, body: { error: 'githubNotConnected', detail: 'synthetic-provider-detail' } }
    const refused = await run(script, ['git', 'get'], 'protocol=https\nhost=github.com\n\n')
    assert.notEqual(refused.code, 0)
    assert.equal(refused.stdout, '')
    assert.match(refused.stderr, /connect GitHub in Mikka/)
    assert.doesNotMatch(refused.stderr + refused.stdout, /synthetic-provider-detail|orv_/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('installation stages as root, installs 0600 for user, and puts no secret in any command', async () => {
  const writes: { path: string; data: string; user: string }[] = [], commands: { command: string; user: string }[] = []
  const sandbox = {
    files: { write: async (path: string, data: string, options: { user: 'root' }) => { writes.push({ path, data, user: options.user }) } },
    commands: { run: async (command: string, options: { user: 'root' | 'user'; timeoutMs: number }) => { commands.push({ command, user: options.user }) } },
  }
  await installDesktopGitHub(sandbox, desktopGitHubConfig('https://mikka.example/mikka', deviceId))
  assert.ok(writes.every(write => write.user === 'root' && write.path.startsWith('/run/mikka-viewer/')))
  assert.ok(commands[0].command.includes('install -o user -g user -m 0600') && commands[0].user === 'root')
  assert.ok(commands.some(entry => entry.user === 'user' && entry.command.includes('credential.https://github.com.helper')))
  for (const { data } of writes) assert.doesNotMatch(data, /orv_|ghu_|ghp_/)
  for (const { command } of commands) assert.doesNotMatch(command, /orv_|ghu_|ghp_|Bearer/)
  assert.ok(SNAPSHOT_CREDENTIAL_GLOBS.includes('/home/*/.mikka/github/token.json'), 'a cached credential blocks a snapshot and is scrubbed')
})
