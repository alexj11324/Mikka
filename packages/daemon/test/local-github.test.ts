import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RunAssignment } from '@mikka/protocol'
import { prepareLocalGitHub } from '../src/agents/local-github'
import { withRunGitCredentials } from '../src/agents/github-runtime'
import { findOnPath } from '../src/path-search'
import { RunContext } from '../src/agents/run-context'
import { sweepRunCredentials } from '../src/agents/harness-home'
import { runCredentialGlobs } from '../src/credential-globs'
import { RunJournal } from '../src/runs/journal'
import { RunSupervisor, type SupervisorDeps } from '../src/runs/supervisor'
import { WorktreeManager } from '../src/worktrees'
import { createLogger } from '../src/log'
import type { AgentAdapter } from '../src/adapters/types'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); cleanupTempDirs() })
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

function fixture() {
  const root = tempDir(), bin = join(root, 'bin'), stateDir = join(root, 'state', 'github')
  mkdirSync(bin)
  // A native CLI fixture reads a login once, just like go-gh config.Read.
  // It never contacts Mikka or a provider, and emits only token digests.
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path')
const file = path.join(process.env.GH_CONFIG_DIR, 'hosts.yml')
const token = JSON.parse(/^\\s+oauth_token: (.+)$/m.exec(fs.readFileSync(file, 'utf8'))[1])
const hash = crypto.createHash('sha256').update(token).digest('hex')
const args = process.argv.slice(2)
if (args[0] === 'auth' && args[1] === 'git-credential') {
  process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('username=x-access-token\\npassword=' + token + '\\n\\n'))
} else {
  console.log(JSON.stringify({ args, hash }))
  if (args.includes('--watch') && process.env.TEST_WAIT_FOR_TOKEN && hash !== process.env.TEST_WAIT_FOR_TOKEN) process.stdin.resume()
  else process.exit(Number(process.env.TEST_NATIVE_EXIT ?? 0))
}
`, { mode: 0o700 })
  const assignment: RunAssignment = { runId: 'local-github-run', deviceId: 'device', issueId: 'issue', repoId: 'repo', harness: 'codex', prompt: 'work',
    github: { endpoint: 'https://mikka.invalid/api/runs/github-token', repository: 'owner/repo', branch: 'mikka/task',
      token: 'synthetic-initial-github', expiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString() } }
  const controller = new AbortController(), onCredential = vi.fn()
  const githubLease = vi.fn(async () => ({ token: 'synthetic-renewed-github', expiresAt: new Date(Date.now() + 4 * 3_600_000).toISOString() }))
  const host = { stateDir, link: { githubLease }, signal: controller.signal, onCredential, path: `${bin}${delimiter}${process.env.PATH ?? ''}` }
  return { root, bin, assignment, controller, onCredential, githubLease, host }
}

it('prepares a private native login once and gives every harness only local Git/gh credential reads', async () => {
  const repo = await makeRepo(), f = fixture(), original = join(f.root, 'personal-gh')
  mkdirSync(original); writeFileSync(join(original, 'hosts.yml'), 'personal login stays intact')
  vi.stubEnv('GH_CONFIG_DIR', original)
  const prepared = (await prepareLocalGitHub(f.assignment, f.host))!
  try {
    expect(f.githubLease).not.toHaveBeenCalled()
    expect(statSync(join(prepared.env.GH_CONFIG_DIR, 'hosts.yml')).mode & 0o077).toBe(0)
    expect(JSON.stringify(prepared.env)).not.toContain(f.assignment.github!.token)
    for (const harness of ['claude_code', 'codex', 'cursor'] as const) {
      const runDir = join(f.root, harness)
      const context = new RunContext({ harness, worktree: repo, runDir, privateDir: f.root,
        github: { ...f.assignment.github!, issueId: f.assignment.issueId }, githubEnvironment: prepared.env })
      const env = { ...process.env, ...context.tempEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
      expect(existsSync(join(runDir, 'github', 'config.json'))).toBe(false)
      const git = execFileSync('git', ['credential', 'fill'], { cwd: repo, env, encoding: 'utf8', input: 'protocol=https\nhost=github.com\n\n' })
      expect(git).toContain(`password=${f.assignment.github!.token}`)
      const flags = ['pr', 'checks', 'https://github.com/owner/repo/pull/1', '--watch', '--required', '--fail-fast']
      const gh = JSON.parse(execFileSync('gh', flags, { env, encoding: 'utf8' }))
      expect(gh).toEqual({ args: flags, hash: digest(f.assignment.github!.token!) })
    }
    expect(f.githubLease).not.toHaveBeenCalled()
    expect(readFileSync(join(original, 'hosts.yml'), 'utf8')).toBe('personal login stays intact')
  } finally { prepared.close() }
  expect(readdirSync(f.host.stateDir)).toEqual([])
})

it('renews only at natural expiry and stops all renewal and credential retention at run end', async () => {
  vi.useFakeTimers()
  const f = fixture(), prepared = (await prepareLocalGitHub(f.assignment, f.host))!
  const file = join(prepared.env.GH_CONFIG_DIR, 'hosts.yml')
  try {
    await vi.advanceTimersByTimeAsync(50 * 60_000)
    expect(f.githubLease).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(70 * 60_000 - 30_001)
    expect(f.githubLease).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.githubLease).toHaveBeenCalledExactlyOnceWith('device', 'local-github-run', f.controller.signal)
    expect(readFileSync(file, 'utf8')).toContain('synthetic-renewed-github')
    expect(f.onCredential).toHaveBeenLastCalledWith('GITHUB_TOKEN', 'synthetic-renewed-github')
    const gh = JSON.parse(execFileSync('gh', ['api', 'user'], { env: { ...process.env, ...prepared.env }, encoding: 'utf8' }))
    expect(gh.hash).toBe(digest('synthetic-renewed-github'))
    expect(f.githubLease).toHaveBeenCalledOnce()
    f.controller.abort()
  } finally { prepared.close() }
  expect(existsSync(file)).toBe(false)
  await vi.advanceTimersByTimeAsync(24 * 3_600_000)
  expect(f.githubLease).toHaveBeenCalledOnce()
})

it('keeps real Git credential reads working without gh, including after a background renewal', async () => {
  vi.useFakeTimers()
  const f = fixture(), bin = join(f.root, 'git-only')
  mkdirSync(bin); symlinkSync(findOnPath('git')!, join(bin, 'git'))
  const prepared = (await prepareLocalGitHub(f.assignment, { ...f.host, path: bin }))!
  const env = { ...process.env, ...prepared.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const fill = () => execFileSync('git', ['credential', 'fill'], { env, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
  try {
    expect(findOnPath('gh', prepared.env.PATH)).toBeNull()
    expect(fill()).toContain('password=synthetic-initial-github')
    expect(f.githubLease).not.toHaveBeenCalled()
    expect(await withRunGitCredentials(f.assignment, f.root, (_env, github) => github.defaultBranch(), prepared.env)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(2 * 3_600_000 - 30_000)
    expect(f.githubLease).toHaveBeenCalledOnce()
    expect(fill()).toContain('password=synthetic-renewed-github')
    expect(f.githubLease).toHaveBeenCalledOnce()
    expect(() => execFileSync('gh', ['--version'], { env })).toThrow('ENOENT')
  } finally { prepared.close() }
})

it.each(['rotation', 'stop'] as const)('preserves a native watch flags and exit semantics after %s', async reason => {
  const f = fixture(), prepared = (await prepareLocalGitHub(f.assignment, f.host))!
  const flags = ['pr', 'checks', '7', '--watch', '--required', '--fail-fast']
  const child = spawn('gh', flags, { env: { ...process.env, ...prepared.env,
    TEST_WAIT_FOR_TOKEN: digest('synthetic-renewed-github'), TEST_NATIVE_EXIT: '8' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let first!: () => void
  const ready = new Promise<void>(resolve => { first = resolve })
  const lines: Array<{ args: string[]; hash: string }> = []
  let pending = ''
  child.stdout.setEncoding('utf8').on('data', data => {
    pending += data
    for (;;) {
      const end = pending.indexOf('\n')
      if (end < 0) break
      lines.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1)
      first()
    }
  })
  const ended = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  try {
    await ready
    if (reason === 'stop') child.kill('SIGTERM')
    else {
      const file = join(prepared.env.GH_CONFIG_DIR, 'hosts.yml')
      writeFileSync(`${file}.next`, readFileSync(file, 'utf8').replace('synthetic-initial-github', 'synthetic-renewed-github'))
      renameSync(`${file}.next`, file)
    }
    expect(await ended).toBe(reason === 'stop' ? 143 : 8)
    expect(lines).toEqual([{ args: flags, hash: digest('synthetic-initial-github') },
      ...(reason === 'rotation' ? [{ args: flags, hash: digest('synthetic-renewed-github') }] : [])])
    expect(f.githubLease).not.toHaveBeenCalled()
  } finally { child.kill('SIGTERM'); child.stdin.end(); prepared.close() }
})

it('does not retry a failed non-watch native command or convert its result into success', async () => {
  const f = fixture(), prepared = (await prepareLocalGitHub(f.assignment, f.host))!
  const args = ['pr', 'create', '--title', 'synthetic offline fixture']
  try {
    let failure: { status?: number; stdout?: string } | undefined
    try { execFileSync('gh', args, { env: { ...process.env, ...prepared.env, TEST_NATIVE_EXIT: '7' }, encoding: 'utf8' }) }
    catch (error) { failure = error as typeof failure }
    expect(failure?.status).toBe(7)
    expect(failure?.stdout?.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(failure!.stdout!)).toEqual({ args, hash: digest('synthetic-initial-github') })
    expect(f.githubLease).not.toHaveBeenCalled()
  } finally { prepared.close() }
})

it('reacquires a restarted run once without MCP and sweeps a crashed login before resume', async () => {
  const f = fixture()
  delete f.assignment.github!.token
  const prepared = (await prepareLocalGitHub(f.assignment, f.host))!
  expect(f.githubLease).toHaveBeenCalledOnce()
  const file = join(prepared.env.GH_CONFIG_DIR, 'hosts.yml')
  expect(readFileSync(file, 'utf8')).toContain('synthetic-renewed-github')
  expect(runCredentialGlobs(join(f.root, 'state'))).toContain(`${join(f.root, 'state')}/github/*`)
  f.controller.abort()
  sweepRunCredentials(join(f.root, 'state'))
  expect(existsSync(file)).toBe(false)
  prepared.close()
})

it.each(['submitted', 'start-failure', 'cancelled'] as const)('keeps the local credential through all Supervisor work and cleans up after %s', async mode => {
  const f = fixture(), repo = await makeRepo(), journal = new RunJournal(join(f.root, 'journal.json'))
  const phases: string[] = []
  let directory: string | undefined, started!: () => void, stop!: () => void
  const ready = new Promise<void>(resolve => { started = resolve }), ending = new Promise<void>(resolve => { stop = resolve })
  const holdsCredential = (env: Record<string, string> | undefined) => {
    expect(env?.GH_CONFIG_DIR).toBe(directory)
    expect(readFileSync(join(directory!, 'hosts.yml'), 'utf8')).toContain('synthetic-initial-github')
  }
  const adapter: AgentAdapter = { harness: 'mock', capabilities: { supportsInterject: false, supportsResume: false }, envAllow: [],
    async start(options) {
      phases.push('adapter'); holdsCredential(options.githubEnvironment); started()
      if (mode === 'start-failure') throw Error('Synthetic CLI startup failure')
      return { sessionId: 'session', async *events() {
        if (mode === 'cancelled') { await ending; yield { type: 'exit' as const, outcome: 'cancelled' as const } }
        else yield { type: 'exit' as const, outcome: 'succeeded' as const, stopReason: 'submitted' as const, report: { summary: 'Ready' } }
      }, async cancel() { stop() }, async send() {} }
    }, async resume() { throw Error('Unexpected resume') },
  }
  const supervisor = new RunSupervisor({ journal, log: createLogger({ level: 'silent' }),
    outbox: { push() {}, async compact() {}, lastChunkSeq() { return 0 } } as unknown as SupervisorDeps['outbox'],
    adapters: new Map([['mock', adapter]]), worktrees: new WorktreeManager(join(f.root, 'worktrees')),
    repository: () => ({ repoId: 'repo', name: 'fixture', path: repo }), baseRef: async () => 'main',
    prepareRunGitHub: async (assignment, signal, onCredential) => {
      phases.push('prepare')
      const prepared = (await prepareLocalGitHub(assignment, { ...f.host, signal, onCredential }))!
      directory = prepared.env.GH_CONFIG_DIR
      return { env: prepared.env, close() { phases.push('close'); prepared.close() } }
    },
    prepareRepository: async (_assignment, _signal, env) => { phases.push('repository'); holdsCredential(env) },
    verify: async ({ githubEnvironment }) => { phases.push('verify'); holdsCredential(githubEnvironment); return { exitCode: 0, signal: null, timedOut: false, output: 'verified' } },
    publisher: { snapshot: async () => 'c'.repeat(40), publish: async ({ githubEnvironment }) => {
      phases.push('publish'); holdsCredential(githubEnvironment)
      return { branch: 'mikka/task', commit: 'a'.repeat(40), pushed: true, remote: 'origin' }
    } },
  })
  try {
    supervisor.start({ ...f.assignment, harness: 'mock', verifyCommand: 'true', leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() })
    if (mode === 'cancelled') { await ready; await supervisor.cancel(f.assignment.runId) }
    await supervisor.idle()
    expect(phases).toEqual(mode === 'submitted' ? ['prepare', 'repository', 'adapter', 'verify', 'publish', 'close'] : ['prepare', 'repository', 'adapter', 'close'])
    expect(existsSync(directory!)).toBe(false)
    expect(f.githubLease).not.toHaveBeenCalled()
    expect(readFileSync(join(f.root, 'journal.json'), 'utf8')).not.toContain('synthetic-initial-github')
  } finally { await supervisor.stop() }
})
