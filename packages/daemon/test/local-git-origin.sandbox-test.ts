import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { RunContext } from '../src/agents/run-context'
import { SandboxRuntime, shellQuote } from '../src/agents/sandbox'

test('a fixture push preserves host Git configuration and cannot trigger the signed-commit GPG path', { timeout: 30_000 }, async () => {
  assert.ok(SandboxRuntime.supported(), 'This integration target requires the official sandbox dependencies')
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mikka-mvp-origin-'))
  const origin = join(root, `mvp-${randomUUID()}`, 'origin.git'), repo = join(root, 'repo')
  const run = join(root, 'run'), privateDir = join(root, 'private'), marker = join(root, 'host-program-invoked')
  const environment = { MIKKA_LOCAL_TEST_ACCOUNTS: '1', E2E_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/fixture_e2e', MIKKA_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/fixture_e2e', DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/fixture_e2e', ORVILO_DATABASE_URL: '', VERCEL: '', VERCEL_ENV: '', MIKKA_DEV_GIT_ORIGIN: origin }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  const childEnvironment = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: repo, env: childEnvironment, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const sandbox = new SandboxRuntime()
  try {
    mkdirSync(origin, { recursive: true }); mkdirSync(repo); mkdirSync(privateDir)
    git(['init', '--bare', origin]); git(['init', '-b', 'main'])
    writeFileSync(join(repo, 'README.md'), 'Fixture push\n')
    git(['add', 'README.md']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'])
    git(['remote', 'add', 'origin', 'https://github.com/mikka-e2e/core-loop.git'])
    const policy = defaultRunPolicy(); policy.permissions.git_push = 'allow'; policy.permissions.network = 'deny'
    const context = new RunContext({ harness: 'claude_code', kind: 'implement', worktree: repo, runDir: run, privateDir, policy,
      githubRuntime: { nodeBinary: process.execPath, ghBinary: '/bin/true' },
      github: { repository: 'mikka-e2e/core-loop', branch: 'main', issueId: randomUUID(), endpoint: 'http://localhost:3110/mikka/api/runs/github-token', runToken: 'synthetic' } })
    await sandbox.probe()
    const action = async (argv: string[]) => {
      const wrapped = await sandbox.wrap(argv, context.policy())
      try {
        return await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          const child = spawn('/bin/sh', ['-c', wrapped.command], { cwd: repo, env: { ...childEnvironment, HOME: run, ...context.tempEnv() }, stdio: ['ignore', 'ignore', 'pipe'] })
          let stderr = ''
          child.stderr.on('data', chunk => { stderr += chunk })
          child.once('error', reject); child.once('exit', code => resolve({ code, stderr }))
        })
      } finally { wrapped.release() }
    }
    const pushed = await action(['git', 'push', 'origin', 'HEAD:main'])
    assert.equal(pushed.code, 0, pushed.stderr)
    assert.equal(git(['--git-dir', origin, 'rev-parse', 'main']), git(['rev-parse', 'HEAD']))
    const config = join(origin, 'config'), originalConfig = readFileSync(config, 'utf8'), program = join(run, 'fake-gpg')
    writeFileSync(program, `#!/bin/sh\nprintf invoked > ${shellQuote(marker)}\nexit 1\n`, { mode: 0o700 })
    const payload = `tree ${git(['rev-parse', 'HEAD^{tree}'])}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fixture\n -----END PGP SIGNATURE-----\n\nFixture signature probe\n`
    const commit = git(['--git-dir', origin, 'hash-object', '-t', 'commit', '-w', '--stdin'], payload)
    // Positive exploit control: this is the exact host Git read used by the
    // fixture's PR verification, and it executes a writable local gpg.program.
    git(['--git-dir', origin, 'config', 'log.showSignature', 'true'])
    git(['--git-dir', origin, 'config', 'gpg.program', program])
    git(['--git-dir', origin, 'show', '-s', '--format=%B', commit])
    assert.ok(existsSync(marker), 'The control did not reach the demonstrated host execution path')
    writeFileSync(config, originalConfig); rmSync(marker)
    for (const args of [['log.showSignature', 'true'], ['gpg.program', program]]) {
      const denied = await action(['git', '--git-dir', origin, 'config', ...args])
      assert.notEqual(denied.code, 0, 'The run changed host-owned bare configuration')
      assert.match(denied.stderr, /permission denied|read.only|resource busy|could not write config/i)
    }
    const deniedHook = await action(['/bin/sh', '-c', `printf probe > ${shellQuote(join(origin, 'hooks', 'untrusted'))}`])
    assert.notEqual(deniedHook.code, 0)
    assert.match(deniedHook.stderr, /permission denied|read.only|operation not permitted/i)
    assert.equal(readFileSync(config, 'utf8'), originalConfig)
    git(['--git-dir', origin, 'show', '-s', '--format=%B', commit])
    assert.equal(existsSync(marker), false, 'The original host GPG marker path remained exploitable')
  } finally {
    await sandbox.reset()
    for (const key of Object.keys(environment)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
    rmSync(root, { recursive: true, force: true })
  }
})
