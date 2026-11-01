import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import lockfile from 'proper-lockfile'
import { daemonTestMode, normalizeRepository, remoteKey, repositoryBindingMatches } from '@mikka/protocol/repository'
import { Daemon } from '../src/main'
import { runCli } from '../src/cli'
import { RepositoryCache } from '../src/repositories'
import { MemoryServer } from '../src/server-link'
import { WorktreeManager } from '../src/worktrees'
import { worktreeGitWritePaths } from '../src/agents/publish'
import { runPolicy } from '../src/permissions'
import { RunContext } from '../src/agents/run-context'
import { makeRepo, tempDir, waitFor } from './helpers'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const daemons: Daemon[] = []
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.stop() })

describe('repository URL boundary', () => {
  it('expands GitHub shorthand and matches HTTPS, SSH and scp identities', () => {
    expect(normalizeRepository('Owner/Repo')).toEqual({ remoteUrl: 'https://github.com/Owner/Repo.git', key: 'v2/github.com/owner/repo' })
    expect(normalizeRepository('Owner/Repo.git').remoteUrl).toBe('https://github.com/Owner/Repo.git')
    for (const url of ['https://github.com/Owner/Repo.git', 'git@github.com:Owner/Repo.git', 'ssh://git@github.com/Owner/Repo.git']) {
      expect(normalizeRepository(url).key).toBe(remoteKey(url))
      expect(normalizeRepository(url).key).toBe('v2/github.com/owner/repo')
    }
  })
  it('refuses local paths, executable transports, URL credentials and path traversal', () => {
    for (const url of ['/tmp/repo', '../repo', '~/repo', 'C:\\repo', 'file:///tmp/repo', 'ext::sh -c true', 'git://host/owner/repo', 'http://host/owner/repo', 'https://secret@host/owner/repo', 'https://host/a/../owner/repo', 'https://host/a/%2e%2e/owner/repo', 'git@host:../repo', 'host:-oProxyCommand=bad']) {
      expect(() => normalizeRepository(url)).toThrow()
    }
    expect(normalizeRepository('file:///tmp/origin.git', { allowFile: true }).key).toBe('v2/file/localhost/tmp/origin.git')
  })
  it('requires an explicit isolated test switch and never opens production', () => {
    expect(daemonTestMode({ NODE_ENV: 'test' })).toBe(false)
    expect(daemonTestMode({ NODE_ENV: 'production', MIKKA_TEST_MODE: '1' })).toBe(false)
    expect(daemonTestMode({ NODE_ENV: 'production', MIKKA_TEST_MODE: '1', CI: 'true' })).toBe(true)
    expect(daemonTestMode({ MIKKA_TEST_MODE: '1', VERCEL_ENV: 'preview' })).toBe(true)
    expect(daemonTestMode({ MIKKA_TEST_MODE: '1', CI: 'true', NODE_ENV: 'test', VERCEL_ENV: 'production' })).toBe(false)
  })
  it('separates routing namespaces and cache paths that the legacy key conflated', () => {
    const cache = new RepositoryCache(join(tempDir(), 'repos'))
    for (const [a, b] of [
      ['https://git.example.com:8443/Team/Repo.git', 'https://git.example.com:9443/team/repo.git'],
      ['https://git.example.com/Team/Repo.git', 'https://git.example.com/team/repo.git'],
      ['https://git.example.com/team/repo', 'https://git.example.com/team/repo.git'],
      ['ssh://alice@git.example.com/team/repo.git', 'ssh://bob@git.example.com/team/repo.git'],
      ['git@git.example.com:team/repo.git', 'ssh://git@git.example.com/team/repo.git'],
      ['ssh://git@git.example.com:22/team/repo.git', 'ssh://git@git.example.com:2222/team/repo.git'],
      ['https://github.com:8443/owner/repo.git', 'https://github.com/owner/repo.git'],
      ['ssh://alice@github.com/owner/repo.git', 'ssh://git@github.com/owner/repo.git'],
      ['file:///tmp/Origin.git', 'file:///tmp/origin.git'],
    ]) {
      expect(remoteKey(a!)).not.toBe(remoteKey(b!))
      expect(cache.pathFor(a!).toLowerCase()).not.toBe(cache.pathFor(b!).toLowerCase())
      expect(repositoryBindingMatches(remoteKey(a!), b!)).toBe(false)
    }
    expect(remoteKey('https://GIT.example.com:443/Team/Repo.git')).toBe(remoteKey('https://git.example.com/Team/Repo.git'))
    expect(repositoryBindingMatches('git.example.com/team/repo', 'https://git.example.com/Team/Repo.git')).toBe(false)
    expect(repositoryBindingMatches('github.com/owner/repo', 'https://github.com/owner/repo.git')).toBe(false)
    for (const url of ['ssh://git.example.com/team/repo.git', 'git.example.com:team/repo.git']) expect(() => normalizeRepository(url)).toThrow()
    expect(repositoryBindingMatches(remoteKey('file:///tmp/origin.git'), 'file:///tmp/origin.git')).toBe(false)
    expect(repositoryBindingMatches(remoteKey('file:///tmp/origin.git'), 'file:///tmp/origin.git', { allowFile: true })).toBe(true)
  })
})

describe('daemon-owned clone cache', () => {
  it('prepares and adds worktrees for concurrent runs of one cache without a config lock failure', async () => {
    const origin = await makeRepo()
    const remote = pathToFileURL(origin).href
    const cache = new RepositoryCache(tempDir(), true)
    const worktrees = new WorktreeManager(tempDir())
    const path = await cache.prepare(remote)
    // Runs of one repository start together: the cache is refreshed while
    // each adds its worktree (recording its upstream) and some are discarded.
    const runs = Array.from({ length: 12 }, (_, index) => `concurrent-${index}`)
    await Promise.all([
      cache.prepare(remote),
      ...runs.map(async (runId, index) => {
        await worktrees.create(runId, path, 'origin/main')
        if (index % 3 === 0) expect(await worktrees.discardIfEmpty([runId], worktrees.pathFor(runId), path)).toBe(true)
      }),
      cache.prepare(remote),
    ])
    for (const [index, runId] of runs.entries())
      expect(existsSync(join(worktrees.pathFor(runId), 'README.md'))).toBe(index % 3 !== 0)
  })

  it('serializes concurrent clones, follows origin default branch, and only fetches its cache', async () => {
    const checkout = await makeRepo()
    git(checkout, 'branch', '-m', 'trunk')
    const bare = join(tempDir(), 'origin.git')
    git(checkout, 'clone', '--bare', checkout, bare)
    const remote = pathToFileURL(bare).href
    writeFileSync(join(checkout, 'README.md'), 'uncommitted personal work\n')
    const before = git(checkout, 'status', '--porcelain')
    const cache = new RepositoryCache(join(tempDir(), 'repos'))
    const clones = await Promise.all(Array.from({ length: 5 }, () => cache.prepare(remote)))
    expect(new Set(clones).size).toBe(1)
    expect(await cache.baseRef(remote)).toBe('origin/trunk')
    expect(existsSync(join(clones[0]!, 'README.md'))).toBe(false)
    const trees = new WorktreeManager(join(tempDir(), 'worktrees'))
    const worktree = await trees.create('run1', clones[0]!, await cache.baseRef(remote))
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('# Sandbox\n')
    expect(existsSync(join(worktree, '.env.local'))).toBe(false)
    expect(git(checkout, 'status', '--porcelain')).toBe(before)
    expect(git(checkout, 'worktree', 'list').split('\n')).toHaveLength(1)
    expect(git(checkout, 'branch', '--list', 'mikka/*')).toBe('')
    expect(existsSync(join(checkout, '.git', 'FETCH_HEAD'))).toBe(false)
    expect(await trees.discardIfEmpty(['run1'], worktree, clones[0]!)).toBe(true)
  })
  it('refuses cache symlinks and file origins when the test gate is off', async () => {
    const root = tempDir()
    const cache = new RepositoryCache(join(root, 'repos'), false)
    await expect(cache.prepare('file:///tmp/origin.git')).rejects.toThrow()
    mkdirSync(join(root, 'repos'))
    symlinkSync(tempDir(), join(root, 'repos', 'v2'))
    await expect(cache.prepare('owner/repo')).rejects.toThrow(/symlink/)
    const linkedRoot = join(tempDir(), 'repos')
    symlinkSync(tempDir(), linkedRoot)
    await expect(new RepositoryCache(linkedRoot).prepare('owner/repo')).rejects.toThrow(/symlink/)
  })
  it('cancels a preparation waiting for another thread to release the clone lock', async () => {
    const source = await makeRepo()
    const remote = pathToFileURL(source).href
    const cache = new RepositoryCache(join(tempDir(), 'repos'))
    const path = await cache.prepare(remote)
    const release = await lockfile.lock(path, { realpath: false })
    try {
      const controller = new AbortController()
      const preparing = cache.prepare(remote, controller.signal)
      controller.abort()
      await expect(preparing).rejects.toMatchObject({ name: 'AbortError' })
    } finally { await release() }
    expect(await cache.prepare(remote)).toBe(path)
  })
  it('gives a run its own git metadata and object store, protecting indirection files', async () => {
    const source = await makeRepo()
    const root = tempDir()
    const cache = new RepositoryCache(join(root, 'repos'))
    const path = await cache.prepare(pathToFileURL(source).href)
    const worktree = await new WorktreeManager(join(root, 'worktrees')).create('git-test', path, await cache.baseRef(pathToFileURL(source).href))
    const gitWritePaths = await worktreeGitWritePaths(path, worktree, 'git-test')
    const context = new RunContext({ harness: 'codex', worktree, gitWritePaths, privateDir: root, runDir: join(root, 'run') })
    expect(context.policy().allowWrite).toContain(join(path, '.git', 'objects'))
    expect(context.policy().allowWrite).toContain(context.gitDir)
    // The branch ref's directory (not just the ref file) must be writable so git
    // can create <branch>.lock when committing; binding only the leaf leaves the
    // dir read-only and `git commit` fails with EROFS.
    expect(context.policy().allowWrite).toContain(join(path, '.git', 'refs', 'heads', 'mikka'))
    expect(context.policy().allowWrite).toContain(join(path, '.git', 'logs', 'refs', 'heads', 'mikka'))
    expect(context.policy().denyWrite).toContain(join(context.gitDir, 'commondir'))
    expect(context.policy().allowWrite).not.toContain(source)
    const readonly = new RunContext({ harness: 'codex', worktree, gitWritePaths, privateDir: root, runDir: join(root, 'readonly'), policy: { ...runPolicy(undefined), readOnly: true } })
    expect(readonly.policy().allowWrite).not.toContain(context.gitDir)
    expect(readonly.policy().denyWrite).toContain(context.gitDir)
  })
  it('a real daemon claims a URL-only assignment without registering any repository', async () => {
    const source = await makeRepo()
    const bare = join(tempDir(), 'origin.git')
    git(source, 'clone', '--bare', source, bare)
    const server = new MemoryServer('device-no-repos')
    const dataDir = tempDir()
    const messages: string[] = []
    expect(await runCli(['daemon', 'login', '--dev', '--data-dir', dataDir, '--token', 'isolated-test-token'], {
      out: message => messages.push(message), err: message => messages.push(message),
    })).toBe(0)
    expect(messages.join('\n')).not.toContain('isolated-test-token')
    const daemon = await new Daemon({ dataDir, flavor: 'dev', agentSandbox: null, link: server.link(),
      harnesses: [{ harness: 'mock', installed: true, version: 'test' }], mockSpeed: Infinity, heartbeatMs: 25, quotaSource: null }).start()
    daemons.push(daemon)
    await daemon.syncWithServer()
    const runId = server.queueRun('device-no-repos', { issueId: 'issue-url', repoId: 'record-only', remoteUrl: pathToFileURL(bare).href,
      harness: 'mock', prompt: 'Write the usage note', fixture: 'success-edit', verifyCommand: 'git diff --check' })
    await daemon.syncWithServer()
    await waitFor(() => daemon.supervisor.list().find(run => run.runId === runId))
    await daemon.supervisor.idle()
    await waitFor(() => daemon.status().pendingUploads === 0)
    expect(server.repos.size).toBe(0)
    expect(server.devices.get('device-no-repos')?.credential).toBe('isolated-test-token')
    expect(daemon.supervisor.get(runId).state).toBe('succeeded')
    expect(server.runs.get(runId)?.completion?.report.publish?.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(git(source, 'worktree', 'list').split('\n')).toHaveLength(1)
    expect(git(source, 'branch', '--list', 'mikka/*')).toBe('')
  })
})
