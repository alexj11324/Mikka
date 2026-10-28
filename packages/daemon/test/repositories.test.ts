import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import lockfile from 'proper-lockfile'
import { daemonTestMode, normalizeRepository, remoteKey } from '@mikka/protocol/repository'
import { Daemon } from '../src/main'
import { runCli } from '../src/cli'
import { RepositoryCache } from '../src/repositories'
import { MemoryServer } from '../src/server-link'
import { WorktreeManager } from '../src/worktrees'
import { worktreeGitWritePaths } from '../src/agents/publish'
import { runPolicy } from '../src/permissions'
import { RunContext } from '../src/agents/run-context'
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from './helpers'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const daemons: Daemon[] = []
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.stop(); cleanupTempDirs() })

describe('repository URL boundary', () => {
  it('expands GitHub shorthand and matches HTTPS, SSH and scp identities', () => {
    expect(normalizeRepository('Owner/Repo')).toEqual({ remoteUrl: 'https://github.com/Owner/Repo.git', key: 'github.com/owner/repo' })
    expect(normalizeRepository('Owner/Repo.git').remoteUrl).toBe('https://github.com/Owner/Repo.git')
    for (const url of ['https://github.com/Owner/Repo.git', 'git@github.com:Owner/Repo.git', 'ssh://git@github.com/Owner/Repo.git']) {
      expect(normalizeRepository(url).key).toBe(remoteKey(url))
      expect(normalizeRepository(url).key).toBe('github.com/owner/repo')
    }
  })
  it('refuses local paths, executable transports, URL credentials and path traversal', () => {
    for (const url of ['/tmp/repo', '../repo', '~/repo', 'C:\\repo', 'file:///tmp/repo', 'ext::sh -c true', 'git://host/owner/repo', 'http://host/owner/repo', 'https://secret@host/owner/repo', 'https://host/a/../owner/repo', 'https://host/a/%2e%2e/owner/repo', 'git@host:../repo', 'host:-oProxyCommand=bad']) {
      expect(() => normalizeRepository(url)).toThrow()
    }
    expect(normalizeRepository('file:///tmp/origin.git', { allowFile: true }).key).toBe('file/localhost/tmp/origin')
  })
  it('requires an explicit isolated test switch and never opens production', () => {
    expect(daemonTestMode({ NODE_ENV: 'test' })).toBe(false)
    expect(daemonTestMode({ NODE_ENV: 'production', MIKKA_TEST_MODE: '1' })).toBe(false)
    expect(daemonTestMode({ NODE_ENV: 'production', MIKKA_TEST_MODE: '1', CI: 'true' })).toBe(true)
    expect(daemonTestMode({ MIKKA_TEST_MODE: '1', VERCEL_ENV: 'preview' })).toBe(true)
    expect(daemonTestMode({ MIKKA_TEST_MODE: '1', CI: 'true', NODE_ENV: 'test', VERCEL_ENV: 'production' })).toBe(false)
  })
})

describe('daemon-owned clone cache', () => {
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
    symlinkSync(tempDir(), join(root, 'repos', 'github.com'))
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
    const daemon = await new Daemon({ dataDir, flavor: 'dev', link: server.link(),
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
