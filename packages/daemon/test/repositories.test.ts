import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:https'
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
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'

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
  it('uses the default branch recorded by a new clone and refreshes it on later prepares', async () => {
    const source = await makeRepo()
    git(source, 'branch', 'trunk')
    const remote = pathToFileURL(source).href
    const root = tempDir('mikka-clone-head-')
    const trace = join(root, 'git-trace.jsonl')
    const cache = new RepositoryCache(join(root, 'repos'), true)
    await cache.prepare(remote, undefined, { GIT_TRACE2_EVENT: trace })
    const connections = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event?: string; argv?: string[] })
      .filter(event => event.event === 'start' && /(?:^|\/)git-upload-pack$/.test(event.argv?.[0] ?? ''))
    expect(connections).toHaveLength(1)
    expect(await cache.baseRef(remote)).toBe('origin/main')
    git(source, 'symbolic-ref', 'HEAD', 'refs/heads/trunk')
    await cache.prepare(remote)
    expect(await cache.baseRef(remote)).toBe('origin/trunk')
  })

  it('switches repositories through a fresh clone and worktree while retaining the wrong checkout and its dirty files', async () => {
    const wrong = await makeRepo(), correct = await makeRepo()
    writeFileSync(join(correct, 'TARGET.txt'), 'correct repository\n')
    git(correct, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', 'TARGET.txt')
    git(correct, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'target identity')
    const cache = new RepositoryCache(join(tempDir(), 'clones'), true)
    const trees = new WorktreeManager(join(tempDir(), 'worktrees'))
    const wrongUrl = pathToFileURL(wrong).href, correctUrl = pathToFileURL(correct).href
    const wrongClone = await cache.prepare(wrongUrl)
    const original = await trees.create('wrong-run', wrongClone, await cache.baseRef(wrongUrl))
    writeFileSync(join(original, 'unfinished.txt'), 'keep me\n')
    const previousHead = git(original, 'rev-parse', 'HEAD')
    const correctClone = await cache.prepare(correctUrl)
    expect(await trees.continueFrom(correctClone, original, 'correct-run')).toBeNull()
    const selected = await trees.create('correct-run', correctClone, await cache.baseRef(correctUrl))
    expect(git(selected, 'remote', 'get-url', 'origin')).toBe(correctUrl)
    expect(git(selected, 'rev-parse', 'HEAD')).toBe(git(correct, 'rev-parse', 'HEAD'))
    expect(readFileSync(join(selected, 'TARGET.txt'), 'utf8')).toBe('correct repository\n')
    expect(existsSync(join(selected, 'unfinished.txt'))).toBe(false)
    expect(git(original, 'remote', 'get-url', 'origin')).toBe(wrongUrl)
    expect(git(original, 'rev-parse', 'HEAD')).toBe(previousHead)
    expect(readFileSync(join(original, 'unfinished.txt'), 'utf8')).toBe('keep me\n')
  })
  it('reports an empty remote after successful clone and fetch without inventing a first commit', async () => {
    const bare = join(tempDir(), 'empty.git')
    git(tempDir(), 'init', '--bare', '--initial-branch=main', bare)
    const remote = pathToFileURL(bare).href
    const cache = new RepositoryCache(join(tempDir(), 'repos'), true)
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(cache.prepare(remote)).rejects.toMatchObject({ name: 'EmptyRepositoryError', message: 'Repository is empty. Create the first commit before running an Agent.' })
      expect(git(cache.pathFor(remote), 'for-each-ref')).toBe('')
      expect(git(bare, 'for-each-ref')).toBe('')
      expect(git(bare, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    }
  })

  it('preserves a broken remote HEAD failure when the remote has a real branch', async () => {
    const source = await makeRepo()
    const bare = join(tempDir(), 'bad-head.git')
    git(source, 'clone', '--bare', source, bare)
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/missing')
    const cache = new RepositoryCache(join(tempDir(), 'repos'), true)
    const failure = await cache.prepare(pathToFileURL(bare).href).catch(error => error)
    expect(failure).toMatchObject({ exitCode: 1 })
    expect(failure.stderr).toContain('Cannot determine remote HEAD')
    expect(failure.name).not.toBe('EmptyRepositoryError')
    expect(git(bare, 'show-ref', '--verify', 'refs/heads/main')).not.toBe('')
    expect(git(bare, 'symbolic-ref', 'HEAD')).toBe('refs/heads/missing')
  })

  it('does not describe clone authentication or network failures as empty repositories', async () => {
    const tls = tempDir()
    const key = join(tls, 'key.pem'), cert = join(tls, 'cert.pem')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' })
    let requests = 0
    const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
      requests++
      response.writeHead(401, { 'www-authenticate': 'Basic realm="Mikka fixture"' }).end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local HTTPS fixture unavailable')
    const remote = `https://127.0.0.1:${address.port}/owner/private.git`
    const cache = new RepositoryCache(join(tempDir(), 'repos'), true)
    // This synthetic loopback endpoint is the only child whose TLS check is
    // disabled. No global credentials or configured proxy reach the fixture.
    const env = { GIT_SSL_NO_VERIFY: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_ASKPASS: '', SSH_ASKPASS: '',
      HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '', ALL_PROXY: '', all_proxy: '', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' }
    try {
      const failure = await cache.prepare(remote, undefined, env).catch(error => error)
      expect(failure).toMatchObject({ exitCode: 128 })
      expect(failure.stderr).toMatch(/Username|Authentication|terminal prompts/)
      expect(failure.name).not.toBe('EmptyRepositoryError')
      expect(requests).toBeGreaterThan(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
    const failure = await cache.prepare(remote, undefined, env).catch(error => error)
    expect(failure).toMatchObject({ exitCode: 128 })
    expect(failure.name).not.toBe('EmptyRepositoryError')
  })

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
    // The repository root, as a run declares a repository writable;
    // `.git/config` and `.git/hooks` stay declared read-only. No file inside `.git` is listed
    // (each would be its own mount point, and git renames locks over refs).
    expect(gitWritePaths).toEqual([path])
    expect(context.policy().allowWrite).toContain(path)
    expect(context.policy().allowWrite.filter(p => p.startsWith(join(path, '.git')))).toEqual([])
    expect(context.policy().denyWrite).toEqual(expect.arrayContaining([join(path, '.git', 'config'), join(path, '.git', 'hooks')]))
    expect(context.policy().denyWrite).toContain(join(context.gitDir, 'commondir'))
    expect(context.policy().allowWrite).not.toContain(source)
    const readonly = new RunContext({ harness: 'codex', worktree, gitWritePaths, privateDir: root, runDir: join(root, 'readonly'), policy: { ...runPolicy(undefined), readOnly: true } })
    // A read-only check writes nothing of the repository, its git dir included.
    expect(readonly.policy().allowWrite.filter(p => context.gitDir.startsWith(p))).toEqual([])
    expect(readonly.policy().denyWrite).toContain(path)
    expect(context.gitDir.startsWith(`${path}/`)).toBe(true)
  })
  describe('an empty remote (no commit, no branch)', () => {
    const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    async function emptyRemoteRun(push: boolean) {
      const bare = join(tempDir(), 'empty.git')
      git(tempDir(), 'init', '--bare', '--initial-branch=main', bare)
      const server = new MemoryServer('device-empty')
      const dataDir = tempDir()
      expect(await runCli(['daemon', 'login', '--dev', '--data-dir', dataDir, '--token', 'isolated-test-token'], { out: () => {}, err: () => {} })).toBe(0)
      const daemon = await new Daemon({ dataDir, flavor: 'dev', agentSandbox: null, link: server.link(),
        harnesses: [{ harness: 'mock', installed: true, version: 'test' }], mockSpeed: Infinity, heartbeatMs: 25, quotaSource: null }).start()
      daemons.push(daemon)
      await daemon.syncWithServer()
      const policy = defaultRunPolicy()
      policy.permissions.git_push = push ? 'allow' : 'deny'
      const runId = server.queueRun('device-empty', { issueId: 'issue-empty', repoId: 'record-only', remoteUrl: pathToFileURL(bare).href,
        harness: 'mock', prompt: 'Write a README', fixture: 'success-edit', verifyCommand: 'git diff --check', pushBranch: 'mikka/alex-5', policy })
      await daemon.syncWithServer()
      await waitFor(() => daemon.supervisor.list().find(run => run.runId === runId))
      await daemon.supervisor.idle()
      await waitFor(() => daemon.status().pendingUploads === 0)
      return { bare, daemon, server, runId }
    }

    it('starts from an empty initial commit on the base branch, pushed without force, and pushes the task branch on top', async () => {
      const { bare, daemon, server, runId } = await emptyRemoteRun(true)
      expect(daemon.supervisor.get(runId).state).toBe('succeeded')
      const base = git(bare, 'rev-parse', 'refs/heads/main')
      expect(git(bare, 'rev-parse', `${base}^{tree}`)).toBe(EMPTY_TREE)
      expect(git(bare, 'rev-list', '--parents', '-n', '1', base)).toBe(base)
      const task = git(bare, 'rev-parse', 'refs/heads/mikka/alex-5')
      expect(server.runs.get(runId)?.completion?.report.publish?.commit).toBe(task)
      expect(git(bare, 'rev-parse', `${task}^`)).toBe(base)
      expect(git(bare, 'merge-base', '--is-ancestor', base, task)).toBe('')
    })

    it('a run that may not push works from a local empty commit and leaves the remote untouched', async () => {
      const { bare, daemon, runId } = await emptyRemoteRun(false)
      expect(daemon.supervisor.get(runId).state).toBe('succeeded')
      expect(git(bare, 'for-each-ref')).toBe('')
    })
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
