import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, delimiter } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentPublishedReceipt, prepareGitHubEnvironment } from '../src/agents/github-runtime'
import { RunContext } from '../src/agents/run-context'
import { EventQueue } from '../src/agents/child'
import { RunSupervisor, type SupervisorDeps } from '../src/runs/supervisor'
import { RunJournal } from '../src/runs/journal'
import { createLogger } from '../src/log'
import { ClaudeAdapter } from '../src/adapters/claude'
import { CodexAdapter } from '../src/adapters/codex'
import { NoSandbox } from '../src/agents/sandbox'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { buildChildEnv } from '../src/env'
import type { AgentAdapter } from '../src/adapters/types'
import { snapshotTree, worktreeGitWritePaths } from '../src/agents/publish'
import { runPolicy } from '../src/permissions'
import { WorktreeManager } from '../src/worktrees'
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from './helpers'

afterEach(cleanupTempDirs)
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const github = { endpoint: 'https://mikka.example/mikka/api/runs/github-token', repository: 'owner/repo', branch: 'mikka/mik-1', runToken: 'synthetic-run-token', issueId: '10000000-0000-4000-8000-000000000001' }

async function fixture() {
  const repo = await makeRepo()
  const worktree = await new WorktreeManager(tempDir()).create('github-test', repo, 'main')
  const root = tempDir()
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
if (process.argv[2] === 'pr' && process.argv[3] === 'view') console.log(JSON.stringify({headRefOid:process.env.TEST_HEAD,body:'result\\n\\n<!-- mikka-issue:${github.issueId} -->'}));
else if (process.argv[2] === 'api' && process.argv[3].startsWith('repos/')) console.log(JSON.stringify({sha:process.env.TEST_HEAD,tree:{sha:process.env.TEST_TREE}}));
else console.log(JSON.stringify({data:{repository:{object:{oid:process.env.TEST_CI_HEAD || process.env.TEST_HEAD,statusCheckRollup:{state:process.env.TEST_PENDING ? 'PENDING' : 'SUCCESS'}}}}}));
`, { mode: 0o700 })
  const path = `${bin}${delimiter}${process.env.PATH}`
  const runDir = join(root, 'run')
  mkdirSync(runDir)
  return { repo, worktree, root, path, runDir }
}

it('supplies a private run-local helper to each real harness without modifying the repository', async () => {
  const f = await fixture()
  for (const harness of ['claude_code', 'codex', 'cursor'] as const) {
    const runDir = join(f.root, harness)
    const ctx = new RunContext({ harness, worktree: f.worktree, runDir, privateDir: tempDir(), github, childPath: f.path,
      gitWritePaths: await worktreeGitWritePaths(f.repo, f.worktree, 'github-test') })
    const env = ctx.tempEnv()
    expect(env.PATH.split(delimiter)[0]).toBe(join(runDir, 'github', 'bin'))
    expect(env.GIT_CONFIG_VALUE_0).toBe('')
    expect(env.GIT_CONFIG_VALUE_2).toBe('true')
    const config = join(runDir, 'github', 'config.json')
    expect(statSync(config).mode & 0o077).toBe(0)
    expect(JSON.parse(readFileSync(config, 'utf8')).runToken).toBe(github.runToken)
    expect(git(f.worktree, 'status', '--porcelain')).toBe('')
    expect(ctx.instructions()).toContain('gh pr checks <PR URL> --watch')
    expect(ctx.instructions()).not.toContain('Do not commit, push')
  }
})

it('does not supply credentials to plan or read-only sessions and respects network deny/ceiling', async () => {
  const f = await fixture()
  const policy = runPolicy(undefined)
  for (const options of [{ kind: 'plan' as const }, { policy: { ...policy, readOnly: true } }]) {
    const ctx = new RunContext({ harness: 'codex', worktree: f.worktree, runDir: tempDir(), privateDir: tempDir(), github, childPath: f.path, ...options })
    expect(ctx.tempEnv()).not.toHaveProperty('GIT_CONFIG_COUNT')
    expect(ctx.instructions()).toContain('Do not commit, push')
  }
  const denied = new RunContext({ harness: 'codex', worktree: f.worktree, runDir: tempDir(), privateDir: tempDir(), github, childPath: f.path,
    policy: { ...policy, permissions: { ...policy.permissions, network: 'deny' } } })
  expect(denied.policy().allowDomains).not.toContain('github.com')
  const bounded = new RunContext({ harness: 'codex', worktree: f.worktree, runDir: tempDir(), privateDir: tempDir(), github, childPath: f.path,
    policy: { ...policy, networkCeiling: ['api.github.com'] } })
  expect(bounded.policy().allowDomains).not.toContain('github.com')
})

it('accepts only an already committed and pushed HEAD with passing PR checks; it never commits or pushes', async () => {
  const f = await fixture()
  const remote = join(f.root, 'origin.git')
  git(f.root, 'init', '--bare', '-q', remote)
  writeFileSync(join(f.worktree, 'delivered.txt'), 'agent delivery\n')
  git(f.worktree, 'add', '.')
  git(f.worktree, '-c', 'user.name=Test', '-c', 'user.email=test@mikka.invalid', 'commit', '-qm', 'Agent delivery')
  const head = git(f.worktree, 'rev-parse', 'HEAD')
  git(f.worktree, 'push', '-q', remote, `HEAD:refs/heads/${github.branch}`)
  const config = join(f.root, 'gitconfig')
  writeFileSync(config, `[url "${remote}"]\n\tinsteadOf = https://github.com/owner/repo.git\n`)
  prepareGitHubEnvironment(f.runDir, github, f.path)
  // A compromised run's wrapper must never execute in the outer daemon.
  const escaped = join(f.root, 'escaped')
  writeFileSync(join(f.runDir, 'github', 'bin', 'gh'), `#!/bin/sh\ntouch '${escaped}'\nexit 1\n`)
  writeFileSync(join(f.runDir, 'github', 'config.json'), JSON.stringify({ gh: join(f.runDir, 'github', 'bin', 'gh') }))
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe('Bearer synthetic-run-token')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ repository: github.repository, token: 'synthetic-installation-token', expiresAt: new Date(Date.now() + 3600_000).toISOString() }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address')
  const liveGithub = { ...github, endpoint: `http://127.0.0.1:${address.port}/api/runs/github-token` }
  try {
  const env = { NODE_ENV: 'test' as const, PATH: f.path, GIT_CONFIG_GLOBAL: config, TEST_HEAD: head, TEST_TREE: await snapshotTree(f.repo, f.worktree) }
  const input = { runId: 'github-test', repoPath: f.repo, worktree: f.worktree, tree: await snapshotTree(f.repo, f.worktree), github: liveGithub, privateDir: join(f.root, 'pids'), env }
  const before = git(f.worktree, 'rev-list', '--all', '--count')
  expect(await agentPublishedReceipt(input)).toEqual({ branch: github.branch, commit: head, pushed: true, remote: 'origin' })
  expect(git(f.worktree, 'rev-list', '--all', '--count')).toBe(before)
  expect(git(remote, 'rev-parse', `refs/heads/${github.branch}`)).toBe(head)
  expect(existsSync(escaped)).toBe(false)
  await expect(agentPublishedReceipt({ ...input, env: { ...env, TEST_PENDING: '1' } })).rejects.toThrow('successful CI')
  await expect(agentPublishedReceipt({ ...input, env: { ...env, TEST_HEAD: 'a'.repeat(40) } })).rejects.toThrow('successful CI')
  await expect(agentPublishedReceipt({ ...input, env: { ...env, TEST_CI_HEAD: 'b'.repeat(40) } })).rejects.toThrow('successful CI')
  // Hosted CLI commits belong to its private clone. The daemon imports only
  // the exact successful remote object, without reading that clone's config.
  const base = git(f.worktree, 'rev-parse', 'HEAD~1')
  git(f.worktree, 'update-ref', 'refs/heads/mikka/run-github-test', base, head)
  git(f.worktree, 'read-tree', base)
  const shadow = join(f.runDir, 'runtime-git', '.git')
  mkdirSync(shadow, { recursive: true })
  writeFileSync(join(shadow, 'config'), `[core]\n\tsshCommand = touch '${escaped}'\n[url "ssh://evil.invalid/"]\n\tinsteadOf = https://github.com/\n`)
  expect(await agentPublishedReceipt({ ...input, hosted: true })).toMatchObject({ commit: head, pushed: true })
  expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(f.worktree, 'status', '--porcelain')).toBe('')
  expect(existsSync(escaped)).toBe(false)
  writeFileSync(join(f.worktree, 'delivered.txt'), 'uncommitted after CI\n')
  await expect(agentPublishedReceipt(input)).rejects.toThrow('commit and verify every change')
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})

it('real tool progress keeps a CI wait alive without disabling the watchdog or serializing a fake UI chunk', async () => {
  const f = await fixture()
  const events = new EventQueue()
  const records: unknown[] = []
  const journal = new RunJournal(join(f.root, 'journal.json'))
  const assignment = { runId: 'github-test', issueId: 'issue', deviceId: 'device', repoId: 'repo', harness: 'mock' as const, prompt: 'Wait for CI' }
  journal.put({ assignment, worktree: f.worktree, state: 'queued', sessionId: null, baseCommit: git(f.worktree, 'rev-parse', 'HEAD'), lastSeq: 0, error: null, updatedAt: new Date().toISOString() })
  const adapter: AgentAdapter = { harness: 'mock', envAllow: [], capabilities: { supportsInterject: false, supportsResume: false },
    async start() { return { sessionId: 'watch-session', events: () => events.drain(), async send() {}, async cancel() { events.exit({ outcome: 'cancelled' }) } } },
    async resume() { throw new Error('Unexpected resume') },
  }
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const supervisor = new RunSupervisor({ journal, outbox: { push(_id: string, record: unknown) { records.push(record) }, lastChunkSeq() { return 0 }, async compact() {} },
    worktrees: new WorktreeManager(tempDir()), repository: () => ({ repoId: 'repo', name: 'test', path: f.repo }), async prepareRepository() {},
    adapters: new Map([['mock', adapter]]), log: createLogger({ level: 'silent' }), stallMs: 1000, cancelGraceMs: 10,
  } as unknown as SupervisorDeps)
  try {
    supervisor.resumeAll()
    await waitFor(() => supervisor.get('github-test').state === 'running')
    now += 600
    events.progress()
    await waitFor(() => supervisor.get('github-test').lastProgressAt === new Date(now).toISOString())
    now += 900
    supervisor.check(now)
    expect(supervisor.get('github-test').state).toBe('running')
    expect(JSON.stringify(records)).not.toContain('"type":"progress"')
    now += 1100
    supervisor.check(now)
    await supervisor.idle()
    expect(supervisor.get('github-test').stopReason).toBe('timeout')
  } finally { clock.mockRestore(); events.exit({ outcome: 'cancelled' }); await supervisor.idle() }
})

it.each(['codex', 'claude_code'] as const)('only current %s tool activity produces internal progress', async harness => {
  const root = tempDir(), worktree = await makeRepo()
  const binary = join(import.meta.dirname, 'fakes', harness === 'codex' ? 'fake-codex.mjs' : 'fake-claude.mjs')
  const common = { stateDir: join(root, 'adapters'), sandbox: new NoSandbox(), binary }
  const adapter = harness === 'codex' ? new CodexAdapter(common) : new ClaudeAdapter({ ...common, configDir: tempDir() })
  const session = await adapter.start({ runId: 'progress-test', cwd: worktree, prompt: 'TOOL_PROGRESS_TEST', env: buildChildEnv(),
    log: createLogger({ level: 'silent' }), toolApproval: new ToolApprovalGate('progress-test', { permission: () => 'deny', ask: async () => 'deny', isLive: () => true }) })
  const events = []
  try { for await (const event of session.events()) events.push(event) }
  finally { await session.cancel() }
  expect(events.filter(event => event.type === 'progress')).toEqual([{ type: 'progress' }])
  expect(events.at(-1)).toMatchObject({ type: 'exit', outcome: 'succeeded' })
})
