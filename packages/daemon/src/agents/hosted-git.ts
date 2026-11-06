import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { assertSafeId } from '../ids'
import { withRepoConfig } from '../worktrees'
import { worktreeGitDir } from './publish'

const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never']
const pinPrefix = (runId: string) => `refs/mikka/runtime-shadows/${assertSafeId('run id', runId)}/`

interface HostedGitOptions {
  destination: string
  runId: string
  /** Supplied by the daemon, never inferred from the task's .git file. */
  repository?: string
  env: Record<string, string | undefined>
}

/** A private index, refs and writable object store over retained, read-only Git history. */
export async function cloneHostedGit(options: HostedGitOptions & {
  source: string
  signal?: AbortSignal
}) {
  const source = realpathSync(options.source)
  const git = (args: string[], input?: string) => execa('git', [...SAFE_GIT, ...args], {
    env: options.env, extendEnv: false, stdin: input === undefined ? 'ignore' : undefined,
    ...(input === undefined ? {} : { input }), timeout: 30_000, cancelSignal: options.signal,
    maxBuffer: 1024 * 1024,
  })
  if (!options.repository) {
    await git(['clone', '--no-hardlinks', '--no-checkout', '--', source, options.destination])
    return
  }
  assertSafeId('run id', options.runId)
  const repository = realpathSync(options.repository)
  await withRepoConfig(repository, async () => {
    const sourceGit = await worktreeGitDir(repository, source)
    const refs = (await git(['--git-dir', sourceGit, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags'])).stdout
    const head = (await git(['--git-dir', sourceGit, 'rev-parse', '--verify', 'HEAD'])).stdout.trim()
    const prefix = pinPrefix(options.runId)
    // The CLI may outlive source branch/worktree cleanup. Pin borrowed refs
    // until its processes stop and finishHostedGit copies them off the startup
    // path. A crash keeps the pins until the restored session closes.
    const pins = [`update ${prefix}HEAD ${head}`]
    for (const line of refs.split('\n').filter(Boolean)) {
      const [object, ref] = line.split(' ')
      if (!/^[a-f0-9]{40,64}$/.test(object!) || !ref?.startsWith('refs/')) throw new Error('Hosted repository history unavailable')
      pins.push(`update ${prefix}${ref.slice(5)} ${object}`)
    }
    await git(['--git-dir', sourceGit, 'update-ref', '--stdin'], pins.join('\n') + '\n')
    // Alternates borrow objects without linking their inodes. Commits, index
    // writes and gc in the shadow use its own store and cannot change source
    // objects. The source Git dir came from the daemon's worktree registry.
    await git(['clone', '--shared', '--no-checkout', '--', sourceGit, options.destination])
    await git(['-C', options.destination, 'remote', 'set-url', 'origin', source])
  })
}

/** Called only after this run's CLI process groups have stopped. */
export async function finishHostedGit(options: HostedGitOptions) {
  if (!options.repository) return
  const repository = realpathSync(options.repository)
  const prefix = pinPrefix(options.runId)
  const git = (args: string[], input?: string) => execa('git', [...SAFE_GIT, ...args], {
    env: options.env, extendEnv: false, stdin: input === undefined ? 'ignore' : undefined,
    ...(input === undefined ? {} : { input }), timeout: 30_000, maxBuffer: 1024 * 1024,
  })
  await withRepoConfig(repository, async () => {
    if (existsSync(options.destination)) {
      const directory = join(options.destination, '.git')
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Hosted repository metadata unavailable')
      const alternatesFile = join(directory, 'objects', 'info', 'alternates')
      if (existsSync(alternatesFile)) {
        const alternates = readFileSync(alternatesFile)
        // Without --local, repack copies the borrowed objects into this private
        // store. Do this after execution, preserving independently resumable
        // sessions without retaining source pins for every completed run.
        await git(['--git-dir', directory, 'repack', '-a', '-d'])
        unlinkSync(alternatesFile)
        try { await git(['--git-dir', directory, 'fsck', '--connectivity-only', '--no-dangling']) }
        catch (error) { writeFileSync(alternatesFile, alternates); throw error }
      }
    }
    const refs = (await git(['-C', repository, 'for-each-ref', '--format=%(objectname) %(refname)', prefix])).stdout
    const deletes = refs.split('\n').filter(Boolean).map(line => {
      const [object, ref] = line.split(' ')
      if (!/^[a-f0-9]{40,64}$/.test(object!) || !ref?.startsWith(prefix)) throw new Error('Hosted repository pin unavailable')
      return `delete ${ref} ${object}`
    })
    if (deletes.length) await git(['-C', repository, 'update-ref', '--stdin'], deletes.join('\n') + '\n')
  })
}
