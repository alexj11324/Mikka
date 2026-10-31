import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execa } from 'execa'
import lockfile from 'proper-lockfile'
import { daemonTestMode, normalizeRepository } from '@mikka/protocol/repository'
import { assertBranchName } from './agents/publish'
import { FETCH_GIT, FETCH_TIMEOUT_MS, isInside } from './worktrees'

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
  async prepare(remoteUrl: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const { remoteUrl: remote } = normalizeRepository(remoteUrl, { allowFile: this.allowFile })
    const path = this.pathFor(remote)
    this.ensureParents(dirname(path))
    const release = await this.lock(path, signal)
    try {
      signal?.throwIfAborted()
      const git = (args: string[], cwd?: string) => execa('git', [
        ...FETCH_GIT, '-c', `protocol.file.allow=${this.allowFile ? 'always' : 'never'}`, ...args,
      ], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdin: 'ignore', timeout: FETCH_TIMEOUT_MS, cancelSignal: signal, killDescendants: true })
      if (!existsSync(path)) {
        const temporary = `${path}.clone-${randomUUID()}`
        try {
          await git(['clone', '--no-checkout', '--no-hardlinks', '--no-recurse-submodules', '--', remote, temporary])
          renameSync(temporary, path)
        } finally { if (!this.retainResources) rmSync(temporary, { recursive: true, force: true }) }
      } else {
        this.assertClone(path)
        // The validated assignment is authoritative. A cache's stale remote
        // must never select another repository or an executable transport.
        await git(['remote', 'set-url', 'origin', remote], path)
        await git(['fetch', ...(this.retainResources ? [] : ['--prune']), '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', 'origin'], path)
      }
      this.assertClone(path)
      // Refresh when the host changes its default branch after the first clone.
      await git(['remote', 'set-head', 'origin', '-a'], path)
      return path
    } finally { await release() }
  }

  async baseRef(remoteUrl: string, baseBranch?: string): Promise<string> {
    const path = this.pathFor(remoteUrl)
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
