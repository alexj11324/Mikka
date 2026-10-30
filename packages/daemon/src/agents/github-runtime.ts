import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { execa } from 'execa'
import type { SessionOptions } from '../adapters/types'
import { pinnedGit, snapshotTree } from './publish'
import type { RunPublish } from '@mikka/protocol'
import { runBranch } from '../worktrees'

export type RunGitHub = NonNullable<SessionOptions['github']>
export const GITHUB_CREDENTIAL_SCRIPT = resolve(import.meta.dirname, 'github-credentials.mjs')
const helper = GITHUB_CREDENTIAL_SCRIPT
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Only run-local configuration is written; never a global gh or git login. */
export function prepareGitHubEnvironment(runDir: string, github: RunGitHub, path: string, runtime?: { nodeBinary: string; ghBinary: string }): Record<string, string> {
  const endpoint = new URL(github.endpoint)
  if (!endpoint.pathname.endsWith('/api/runs/github-token') || endpoint.username || endpoint.password ||
    endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)))) throw new Error('Invalid run GitHub endpoint')
  const gh = runtime?.ghBinary ?? path.split(delimiter).map(dir => join(dir, 'gh')).find(file => existsSync(file))
  const node = runtime?.nodeBinary ?? process.execPath
  if (!gh) throw new Error('Install GitHub CLI (gh) before running GitHub tasks')
  const dir = join(runDir, 'github')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== join(realpathSync(runDir), 'github')) throw new Error('Invalid run GitHub directory')
  const config = join(dir, 'config.json')
  rmSync(config, { force: true })
  writeFileSync(config, JSON.stringify({ ...github, gh }), { mode: 0o600, flag: 'wx' })
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  if (!lstatSync(bin).isDirectory() || realpathSync(bin) !== join(realpathSync(dir), 'bin')) throw new Error('Invalid run GitHub executable directory')
  const wrapper = join(bin, 'gh')
  rmSync(wrapper, { force: true })
  writeFileSync(wrapper, `#!/bin/sh\nexec ${process.versions.electron ? 'env ELECTRON_RUN_AS_NODE=1 ' : ''}${quote(node)} ${quote(helper)} gh ${quote(config)} "$@"\n`, { mode: 0o700, flag: 'wx' })
  return {
    PATH: `${bin}${delimiter}${path}`, GH_HOST: 'github.com', GH_REPO: github.repository,
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: `!${process.versions.electron ? 'env ELECTRON_RUN_AS_NODE=1 ' : ''}${quote(node)} ${quote(helper)} git ${quote(config)}`,
    GIT_CONFIG_KEY_2: 'credential.useHttpPath', GIT_CONFIG_VALUE_2: 'true',
    GIT_AUTHOR_NAME: 'Mikka Agent', GIT_AUTHOR_EMAIL: 'agent@mikka.invalid',
    GIT_COMMITTER_NAME: 'Mikka Agent', GIT_COMMITTER_EMAIL: 'agent@mikka.invalid',
  }
}

/** Verify the exact already-pushed commit. Never create a commit or push after CI. */
export async function agentPublishedReceipt(input: {
  runId: string; repoPath: string; worktree: string; tree: string; github: RunGitHub; privateDir: string; hosted?: boolean; env?: NodeJS.ProcessEnv
}): Promise<RunPublish> {
  // No helper, configuration or Git directory writable by the agent is ever
  // executed by the outer daemon. The hosted clone remains container-only.
  mkdirSync(input.privateDir, { recursive: true, mode: 0o700 })
  const receiptDir = mkdtempSync(join(input.privateDir, 'github-receipt-'))
  try {
    const env: NodeJS.ProcessEnv = { NODE_ENV: input.env?.NODE_ENV ?? process.env.NODE_ENV ?? 'production', ...input.env,
      ...prepareGitHubEnvironment(receiptDir, input.github, input.env?.PATH ?? process.env.PATH ?? '') }
    const git = await pinnedGit(input.repoPath, input.worktree, env)
    const originalHead = String((await git(['rev-parse', 'HEAD'])).stdout).trim()
    if (await snapshotTree(input.repoPath, input.worktree, env) !== input.tree) throw new Error('Agent must commit and verify every change before submitting')
    const url = `https://github.com/${input.github.repository}.git`
    const commit = String((await git(['ls-remote', '--exit-code', url, `refs/heads/${input.github.branch}`])).stdout).trim().split(/\s+/)[0]
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid pushed commit')
    if (!input.hosted) {
      const headTree = String((await git(['rev-parse', 'HEAD^{tree}'])).stdout).trim()
      if (originalHead !== commit || headTree !== input.tree) throw new Error('Agent must commit and verify every change before submitting')
    }
    try {
      const gh = (args: string[]) => execa(join(receiptDir, 'github', 'bin', 'gh'), args, { cwd: input.worktree, env, extendEnv: false, stdin: 'ignore' })
      // Hosted runs commit in a container-private clone. Verify GitHub's exact
      // commit/tree rather than reading any config from that writable clone.
      if (input.hosted) {
        const object = JSON.parse((await gh(['api', `repos/${input.github.repository}/git/commits/${commit}`])).stdout)
        if (object.sha !== commit || object.tree?.sha !== input.tree) throw new Error('Uncommitted hosted changes')
      }
      const pr = JSON.parse((await gh(['pr', 'view', input.github.branch, '--repo', input.github.repository, '--json', 'headRefOid,body'])).stdout)
      if (pr.headRefOid !== commit || typeof pr.body !== 'string' || !pr.body.trimEnd().endsWith(`<!-- mikka-issue:${input.github.issueId} -->`)) throw new Error('Unbound pull request')
      const [owner, repository] = input.github.repository.split('/')
      const query = 'query($owner:String!,$repository:String!,$commit:GitObjectID!){repository(owner:$owner,name:$repository){object(oid:$commit){... on Commit {oid statusCheckRollup{state}}}}}'
      const checks = JSON.parse((await gh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `repository=${repository}`, '-f', `commit=${commit}`])).stdout)
      const checked = checks.data?.repository?.object
      if (checked?.oid !== commit || checked.statusCheckRollup?.state !== 'SUCCESS') throw new Error('Incomplete CI')
    } catch { throw new Error('The task pull request and successful CI must match the submitted commit') }
    if (input.hosted) {
      // Import the already-verified object from the trusted remote (not the
      // agent's clone), preserving its SHA for the next continuation. CAS only
      // the daemon-created run ref; no commit is created and nothing is pushed.
      await git(['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', url, commit])
      await git(['update-ref', `refs/heads/${runBranch(input.runId)}`, commit, originalHead])
      await git(['read-tree', commit])
    }
    return { branch: input.github.branch, commit, pushed: true, remote: 'origin' }
  } finally { rmSync(receiptDir, { recursive: true, force: true }) }
}
