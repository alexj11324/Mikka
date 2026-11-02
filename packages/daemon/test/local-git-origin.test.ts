import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { localGitOrigin } from '../src/agents/local-git-origin'
import { prepareGitHubEnvironment } from '../src/agents/github-runtime'
import { RunContext } from '../src/agents/run-context'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'

const directories: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mikka-mvp-origin-')); directories.push(root)
  const origin = join(root, `mvp-${randomUUID()}`, 'origin.git')
  mkdirSync(origin, { recursive: true })
  const database = 'postgresql://fixture:fixture@127.0.0.1/local_git_e2e'
  for (const [name, value] of Object.entries({ MIKKA_LOCAL_TEST_ACCOUNTS: '1', E2E_DATABASE_URL: database, MIKKA_DATABASE_URL: database, DATABASE_URL: database, ORVILO_DATABASE_URL: '', VERCEL: '', VERCEL_ENV: '', MIKKA_DEV_GIT_ORIGIN: origin })) vi.stubEnv(name, value)
  return { root, origin }
}
it('admits only the explicit disposable origin while the shared local test rule holds', () => {
  const { root, origin } = fixture()
  expect(localGitOrigin()).toBe(origin)
  vi.stubEnv('MIKKA_DEV_GIT_ORIGIN', root)
  expect(() => localGitOrigin()).toThrow('Invalid local acceptance Git origin')
  vi.stubEnv('MIKKA_DEV_GIT_ORIGIN', origin)
  for (const [name, value] of [['VERCEL', '1'], ['MIKKA_LOCAL_TEST_ACCOUNTS', '0'], ['DATABASE_URL', 'postgresql://fixture:fixture@remote.example/production']] as const) {
    vi.stubEnv(name, value); expect(localGitOrigin()).toBeUndefined(); vi.stubEnv(name, name === 'MIKKA_LOCAL_TEST_ACCOUNTS' ? '1' : name === 'VERCEL' ? '' : process.env.E2E_DATABASE_URL!)
  }
})
it('the sanitized run Git environment pushes the exact GitHub-shaped origin to the local bare repo', () => {
  const { root, origin } = fixture()
  const worktree = join(root, 'worktree'), run = join(root, 'run'), binaries = join(root, 'bin')
  mkdirSync(worktree); mkdirSync(run); mkdirSync(binaries)
  writeFileSync(join(binaries, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const git = (args: string[], env = process.env) => execFileSync('git', args, { cwd: worktree, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  git(['init', '--bare', origin]); git(['init', '-b', 'main'])
  writeFileSync(join(worktree, 'README.md'), 'local delivery\n')
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'add', 'README.md'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'])
  git(['remote', 'add', 'origin', 'https://github.com/mikka-e2e/core-loop.git'])
  const env = prepareGitHubEnvironment(run, { endpoint: 'http://localhost:3110/mikka/api/runs/github-token', repository: 'mikka-e2e/core-loop', branch: 'main', runToken: 'synthetic', issueId: randomUUID() }, `${binaries}:${process.env.PATH}`)
  // No GIT_CONFIG_GLOBAL or host credentials are carried into the run.
  expect(env.GIT_CONFIG_GLOBAL).toBeUndefined()
  git(['push', 'origin', 'HEAD:main'], { PATH: process.env.PATH, ...env })
  expect(git(['--git-dir', origin, 'rev-parse', 'main'])).toBe(git(['rev-parse', 'HEAD']))
  const policy = defaultRunPolicy()
  policy.permissions.git_push = 'allow'
  mkdirSync(join(root, 'private'))
  const context = (name: string) => new RunContext({
    harness: 'claude_code', kind: 'implement', worktree, runDir: join(root, name), privateDir: join(root, 'private'),
    childPath: `${binaries}:${process.env.PATH}`, policy,
    github: { endpoint: 'http://localhost:3110/mikka/api/runs/github-token', repository: 'mikka-e2e/core-loop', branch: 'main', runToken: 'synthetic', issueId: randomUUID() },
  })
  const writablePolicy = context('writable').policy()
  expect(writablePolicy.allowWrite).toContain(origin)
  expect(writablePolicy.denyWrite).toContain(join(origin, 'config'))
  expect(writablePolicy.denyWrite).toContain(join(origin, 'hooks'))
  policy.readOnly = true
  expect(context('read-only').policy().allowWrite).not.toContain(origin)
  policy.readOnly = false; policy.permissions.git_push = 'deny'
  expect(context('push-denied').policy().allowWrite).not.toContain(origin)
})

it('the local GitHub helper uses its authenticated sandbox proxy for the isolated host loopback', async () => {
  const { root } = fixture()
  const run = join(root, 'proxy-run'), binaries = join(root, 'proxy-bin')
  mkdirSync(run); mkdirSync(binaries)
  writeFileSync(join(binaries, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  let tunneled = 0
  const application = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ repository: 'mikka-e2e/core-loop', token: 'synthetic-installation', expiresAt: '2099-01-01T00:00:00Z' }))
  })
  const proxy = createServer()
  const listen = (server: ReturnType<typeof createServer>) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))
  const applicationPort = await listen(application)
  proxy.on('connect', (request, socket, head) => {
    if (request.url !== `127.0.0.1:${applicationPort}`) { socket.destroy(); return }
    tunneled++
    const upstream = connect(applicationPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy())
  })
  const proxyPort = await listen(proxy)
  try {
    const env = prepareGitHubEnvironment(run, { endpoint: `http://127.0.0.1:${applicationPort}/api/runs/github-token`, repository: 'mikka-e2e/core-loop', branch: 'main', runToken: 'synthetic', issueId: randomUUID() }, `${binaries}:${process.env.PATH}`)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(join(run, 'github/bin/gh'), ['--version'], { env: { ...env, HTTP_PROXY: `http://sandbox:synthetic@127.0.0.1:${proxyPort}`, NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' }, stdio: ['ignore', 'ignore', 'pipe'] })
      let error = ''
      child.stderr.on('data', data => { error += data })
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)))
    })
    expect(tunneled).toBe(1)
  } finally {
    proxy.closeAllConnections(); application.closeAllConnections()
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => application.close(resolve))])
  }
})
