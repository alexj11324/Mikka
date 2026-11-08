import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execa } from 'execa'
import lockfile from 'proper-lockfile'
import { daemonTestMode, normalizeRepository } from '@mikka/protocol/repository'
import type { Harness } from '@mikka/protocol'
import { daemonTracer } from './tracing'
import { assertBranchName } from './agents/publish'
import { FETCH_GIT, FETCH_TIMEOUT_MS, isInside, withRepoConfig } from './worktrees'

type RepositoryDiagnostics = { runIdHash: string; harness: Harness }

/** git's empty tree: an initial commit with no files. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** Where a run that may not push starts on an empty remote. Never pushed. */
const LOCAL_EMPTY_BASE = 'refs/mikka/empty-base'
const INITIAL_COMMIT_ENV = { GIT_AUTHOR_NAME: 'Mikka Agent', GIT_AUTHOR_EMAIL: 'agent@mikka.invalid', GIT_COMMITTER_NAME: 'Mikka Agent', GIT_COMMITTER_EMAIL: 'agent@mikka.invalid' }

export class EmptyRepositoryError extends Error {
  constructor() {
    super('Repository is empty. Create the first commit before running an Agent.')
    this.name = 'EmptyRepositoryError'
  }
}

/** A standard clone owned by the daemon, shared only through per-run worktrees. */
export class RepositoryCache {
  constructor(private readonly root: string, private readonly allowFile = daemonTestMode(process.env), private readonly retainResources = false) {}

  pathFor(remoteUrl: string): string {
    const { key } = normalizeRepository(remoteUrl, { allowFile: this.allowFile })
    // A digest also separates case-sensitive repositories on case-insensitive
    // filesystems and prevents nested repository paths sharing clone roots.
    const path = resolve(this.root, 'v2', createHash('sha256').update(key).digest('hex'))
    if (!isInside(resolve(this.root), path) || path === resolve(this.root)) throw new Error('Invalid repository cache path')
    return path
  }

  /** Serialize clone/fetch against the same cache, including other processes. */
  async prepare(remoteUrl: string, signal?: AbortSignal, env: Record<string, string> = {}, diagnostics?: RepositoryDiagnostics): Promise<string> {
    signal?.throwIfAborted()
    const { remoteUrl: remote } = normalizeRepository(remoteUrl, { allowFile: this.allowFile })
    const path = this.pathFor(remote)
    this.ensureParents(dirname(path))
    const release = await this.lock(path, signal)
    try {
      return await withRepoConfig(path, () => this.update(path, remote, signal, env, diagnostics))
    } finally { await release() }
  }

  private async update(path: string, remote: string, signal?: AbortSignal, env: Record<string, string> = {}, diagnostics?: RepositoryDiagnostics): Promise<string> {
    signal?.throwIfAborted()
    const git = (args: string[], cwd?: string) => {
      const execute = () => execa('git', [
        ...FETCH_GIT, '-c', `protocol.file.allow=${this.allowFile ? 'always' : 'never'}`, ...args,
      ], { cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' }, stdin: 'ignore', timeout: FETCH_TIMEOUT_MS, cancelSignal: signal, killDescendants: true })
      if (!diagnostics) return execute()
      // Explicit run diagnostics only. Never export command arguments,
      // repository URLs, checkout paths or credential environment values.
      const phase = args[0] === 'clone' ? 'clone' : args[0] === 'fetch' ? 'fetch'
        : args[0] === 'remote' && args[1] === 'set-head' ? 'remote_head'
        : args[0] === 'ls-remote' ? 'remote_refs' : 'local'
      return daemonTracer.span(`daemon.repository.git.${phase}`,
        { 'mikka.run.id_hash': diagnostics.runIdHash, 'mikka.harness': diagnostics.harness }, execute)
    }
    let cloned = false
    if (!existsSync(path)) {
      const temporary = `${path}.clone-${randomUUID()}`
      try {
        await git(['clone', '--depth=50', '--no-single-branch', '--no-checkout', '--no-hardlinks', '--no-recurse-submodules', '--', remote, temporary])
        renameSync(temporary, path)
        cloned = true
      } finally { if (!this.retainResources) rmSync(temporary, { recursive: true, force: true }) }
    } else {
      this.assertClone(path)
      // The validated assignment is authoritative. A cache's stale remote
      // must never select another repository or an executable transport.
      await git(['remote', 'set-url', 'origin', remote], path)
      // Empty clones have no shallow boundary; Git 2.56 rejects --depth on
      // their empty fetch. Preserve full legacy caches rather than truncating
      // user history, and retain the depth only for the new shallow clones.
      const depth = existsSync(join(path, '.git', 'shallow')) ? ['--depth=50'] : []
      await git(['fetch', ...depth, ...(this.retainResources ? [] : ['--prune']), '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', 'origin'], path)
    }
    this.assertClone(path)
    let freshHead = false
    if (cloned) {
      try {
        // Clone already asked the remote for HEAD. Check both its symbolic
        // target and commit locally before paying for another remote request.
        const ref = (await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], path)).stdout.trim()
        if (ref.startsWith('refs/remotes/origin/')) {
          await git(['rev-parse', '--verify', `${ref}^{commit}`], path)
          freshHead = true
        }
      } catch { /* Empty or broken HEAD keeps the existing remote diagnosis below. */ }
    }
    // Refresh when the host changes its default branch after the first clone.
    try {
      if (!freshHead) await git(['remote', 'set-head', 'origin', '-a'], path)
      // The remote has commits now: a local empty base from before is stale.
      await git(['update-ref', '-d', LOCAL_EMPTY_BASE], path)
    } catch (error) {
      // A successful ls-remote with no HEAD or refs confirms an empty remote.
      // Authentication/network failures still throw; a broken HEAD with real
      // branches keeps its original error instead of being called empty.
      const refs = await git(['ls-remote', 'origin'], path)
      if (!refs.stdout.trim()) throw new EmptyRepositoryError()
      throw error
    }
    return path
  }

  /**
   * The first commit of an empty remote: no files, on `branch`. The push never
   * forces, so a branch someone created meanwhile is kept and the run then
   * starts from it (prepare again). Call only after prepare reported the
   * remote empty.
   */
  async seedEmpty(remoteUrl: string, branch: string, signal?: AbortSignal, env: Record<string, string> = {}): Promise<void> {
    await assertBranchName(branch)
    const { remoteUrl: remote } = normalizeRepository(remoteUrl, { allowFile: this.allowFile })
    const path = this.pathFor(remote)
    const release = await this.lock(path, signal)
    try {
      await withRepoConfig(path, async () => {
        this.assertClone(path)
        const commit = await this.initialCommit(path)
        const git = (args: string[]) => execa('git', [...FETCH_GIT, '-c', `protocol.file.allow=${this.allowFile ? 'always' : 'never'}`, ...args], {
          cwd: path, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' }, stdin: 'ignore', timeout: FETCH_TIMEOUT_MS, cancelSignal: signal, killDescendants: true, reject: false,
        })
        const pushed = await git(['push', '--no-verify', '--', 'origin', `${commit}:refs/heads/${branch}`])
        // Refused because someone pushed first: fine, the run starts from theirs.
        if (pushed.exitCode !== 0 && !(await git(['ls-remote', 'origin'])).stdout.trim())
          throw new Error(`Could not push the first commit to the empty repository (git exit ${pushed.exitCode})`)
      })
    } finally { await release() }
  }

  /** For a run that may not push to an empty remote: a local empty first commit to start from. */
  async localEmptyBase(remoteUrl: string): Promise<void> {
    const path = this.pathFor(remoteUrl)
    const release = await this.lock(path)
    try {
      await withRepoConfig(path, async () => {
        this.assertClone(path)
        const existing = await execa('git', [...FETCH_GIT, 'rev-parse', '--verify', '-q', LOCAL_EMPTY_BASE], { cwd: path, stdin: 'ignore', reject: false })
        if (existing.exitCode !== 0) await execa('git', [...FETCH_GIT, 'update-ref', LOCAL_EMPTY_BASE, await this.initialCommit(path), ''], { cwd: path, stdin: 'ignore' })
      })
    } finally { await release() }
  }

  private async initialCommit(path: string): Promise<string> {
    await execa('git', [...FETCH_GIT, 'hash-object', '-t', 'tree', '-w', '--stdin'], { cwd: path, input: '' })
    const { stdout } = await execa('git', [...FETCH_GIT, 'commit-tree', EMPTY_TREE, '-m', 'Initial commit'], { cwd: path, stdin: 'ignore', env: { ...process.env, ...INITIAL_COMMIT_ENV } })
    return stdout.trim()
  }

  async baseRef(remoteUrl: string, baseBranch?: string): Promise<string> {
    const path = this.pathFor(remoteUrl)
    // An empty remote a run may not push to: only the local empty base exists.
    const emptyBase = await execa('git', [...FETCH_GIT, 'rev-parse', '--verify', '-q', LOCAL_EMPTY_BASE], { cwd: path, stdin: 'ignore', reject: false })
    if (emptyBase.exitCode === 0) return LOCAL_EMPTY_BASE
    if (baseBranch && baseBranch !== 'HEAD') {
      await assertBranchName(baseBranch)
      return `origin/${baseBranch}`
    }
    const { stdout } = await execa('git', [...FETCH_GIT, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: path, stdin: 'ignore' })
    if (!stdout.startsWith('origin/')) throw new Error('Repository default branch unavailable')
    return stdout.trim()
  }

  /** Cache paths for retention/orphan cleanup; never consult user checkouts. */
  paths(): string[] {
    const visit = (path: string): string[] => {
      if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return []
      if (existsSync(join(path, '.git'))) { this.assertClone(path); return [path] }
      return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() && !entry.name.endsWith('.lock') && !entry.name.includes('.clone-') ? visit(join(path, entry.name)) : [])
    }
    return visit(resolve(this.root))
  }

  private ensureParents(path: string) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    if (lstatSync(this.root).isSymbolicLink()) throw new Error('Repository cache contains a symlink')
    const root = realpathSync(this.root)
    let current = resolve(this.root)
    for (const part of path.slice(current.length + 1).split('/').filter(Boolean)) {
      current = join(current, part)
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Repository cache contains a symlink')
      mkdirSync(current, { recursive: true, mode: 0o700 })
      if (!isInside(root, realpathSync(current))) throw new Error('Repository cache escapes its directory')
    }
  }

  private assertClone(path: string) {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(join(path, '.git')).isDirectory() || lstatSync(join(path, '.git')).isSymbolicLink()) throw new Error('Repository cache is not a standard clone')
    if (!isInside(realpathSync(this.root), realpathSync(path))) throw new Error('Repository cache escapes its directory')
  }

  private async lock(path: string, signal?: AbortSignal): Promise<() => Promise<void>> {
    const deadline = Date.now() + 120_000
    for (;;) {
      signal?.throwIfAborted()
      try {
        return await lockfile.lock(path, { realpath: false, stale: 120_000, update: 10_000, retries: 0 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) throw error
        // Unlike lockfile's internal retries, this wait is cancellable while
        // another thread is cloning the same repository.
        await delay(100, undefined, { signal })
      }
    }
  }
}
