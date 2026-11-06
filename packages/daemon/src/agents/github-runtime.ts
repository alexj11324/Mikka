import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { execa } from 'execa'
import type { SessionOptions } from '../adapters/types'
import { pinnedGit, snapshotTree } from './publish'
import type { RunPublish } from '@mikka/protocol'
import { localGitConfig } from './local-git-origin'
import { trustedServerEndpoint } from '../trusted-endpoint'

export type RunGitHub = NonNullable<SessionOptions['github']>
export const GITHUB_CREDENTIAL_SCRIPT = resolve(import.meta.dirname, 'github-credentials.mjs')
const helper = GITHUB_CREDENTIAL_SCRIPT
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Host-only receipt IO keeps its configured transport, not forge credentials. */
export function githubReceiptEnvironment(host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: host.NODE_ENV ?? 'production' }
  for (const name of ['PATH', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO']) {
    if (host[name] !== undefined) env[name] = host[name]
  }
  return env
}

/**
 * The run owner's own GitHub credential for git and gh, for any github.com
 * repository (decision 2026-11-02-1600). Only run-local configuration is
 * written; never a global gh or git login, and never the token itself.
 */
export function prepareGitHubEnvironment(runDir: string, github: RunGitHub, path: string, runtime?: { nodeBinary: string; ghBinary: string }): Record<string, string> {
  const endpoint = new URL(github.endpoint)
  if (!endpoint.pathname.endsWith('/api/runs/github-token') || !trustedServerEndpoint(endpoint)) throw new Error('Invalid run GitHub endpoint')
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
  const fixtureConfig = localGitConfig()
  // The official sandbox isolates loopback and installs its authenticated
  // proxy. Its NO_PROXY localhost default would bypass that only route back
  // to the local acceptance server. The outer daemon's proxy is preserved.
  const fixtureProxy = fixtureConfig.length ? 'case "${HTTP_PROXY:-${http_proxy:-}}" in http://*@localhost:*|http://*@127.0.0.1:*) unset NO_PROXY no_proxy ;; esac\n' : ''
  writeFileSync(wrapper, `#!/bin/sh\n${fixtureProxy}exec env NODE_USE_ENV_PROXY=1 ${process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}${quote(node)} ${quote(helper)} gh ${quote(config)} "$@"\n`, { mode: 0o700, flag: 'wx' })
  return {
    PATH: `${bin}${delimiter}${path}`, GH_HOST: 'github.com',
    // The agent commits inside the sandbox, where a signing program or agent
    // configured outside it (gpg, ssh-agent, a signing helper) is unreachable.
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: String(5 + fixtureConfig.length),
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: `!${fixtureProxy}env NODE_USE_ENV_PROXY=1 ${process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}${quote(node)} ${quote(helper)} git ${quote(config)}`,
    GIT_CONFIG_KEY_2: 'credential.useHttpPath', GIT_CONFIG_VALUE_2: 'true',
    GIT_CONFIG_KEY_3: 'commit.gpgSign', GIT_CONFIG_VALUE_3: 'false',
    GIT_CONFIG_KEY_4: 'tag.gpgSign', GIT_CONFIG_VALUE_4: 'false',
    ...Object.fromEntries(fixtureConfig.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${5 + index}`, key], [`GIT_CONFIG_VALUE_${5 + index}`, value]])),
    GIT_AUTHOR_NAME: 'Mikka Agent', GIT_AUTHOR_EMAIL: 'agent@mikka.invalid',
    GIT_COMMITTER_NAME: 'Mikka Agent', GIT_COMMITTER_EMAIL: 'agent@mikka.invalid',
  }
}

/**
 * The daemon's own clone and fetch for a GitHub run: git asks the run's
 * credential helper, which exchanges the run token for the run owner's own
 * GitHub credential. A machine without a GitHub login of its own (a cloud
 * sandbox, a new computer) can then clone a private repository. Only git's
 * credential settings are returned; the run-local files are removed after.
 */
export async function withRunGitCredentials<T>(
  assignment: { github?: { endpoint: string; repository: string; branch?: string; token?: string; expiresAt?: string | null }; mcp?: { token: string }; issueId: string },
  privateDir: string,
  work: (env: Record<string, string>, github: { defaultBranch(): Promise<string | undefined> }) => Promise<T>,
): Promise<T> {
  const none = { defaultBranch: async () => undefined }
  if (!assignment.github || (!assignment.github.token && !assignment.mcp)) return work({}, none)
  if (assignment.github.token) {
    const env = {
      GH_TOKEN: assignment.github.token, GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_1: '!gh auth git-credential',
    }
    return work(env, { defaultBranch: async () => {
      const result = await execa('gh', ['api', `repos/${assignment.github!.repository}`, '--jq', '.default_branch'], {
        env: { ...process.env, ...env }, stdin: 'ignore', timeout: 30_000, reject: false,
      })
      return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
    } })
  }
  mkdirSync(privateDir, { recursive: true, mode: 0o700 })
  const dir = mkdtempSync(join(privateDir, 'github-fetch-'))
  try {
    let env: Record<string, string> = {}
    try {
      env = prepareGitHubEnvironment(dir, { ...assignment.github, runToken: assignment.mcp?.token, issueId: assignment.issueId }, process.env.PATH ?? '')
    } catch {
      // No gh on this machine: GitHub delivery is unavailable, and the clone
      // falls back to the machine's own git credentials as before.
      return await work({}, none)
    }
    const repository = assignment.github.repository
    // GitHub's default branch for a repository with no branch yet; undefined when it cannot be read.
    const defaultBranch = async () => {
      const result = await execa('gh', ['api', `repos/${repository}`, '--jq', '.default_branch'], { env: { ...process.env, ...env }, stdin: 'ignore', timeout: 30_000, reject: false })
      const name = result.exitCode === 0 ? result.stdout.trim() : ''
      return name || undefined
    }
    return await work(Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('GIT_CONFIG_') || key === 'GIT_TERMINAL_PROMPT')), { defaultBranch })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** Verify the exact already-pushed commit. Never create a commit or push after CI. */
export async function agentPublishedReceipt(input: {
  runId: string; repoPath: string; worktree: string; tree: string; github: RunGitHub; privateDir: string; hosted?: boolean; env?: NodeJS.ProcessEnv
}): Promise<RunPublish> {
  // The cloud CLI committed in this exact working directory. Local runs keep
  // their repository binding; neither path imports a second shadow history.
  if (!input.github.branch) throw new Error('No task branch to read back')
  const branch = input.github.branch
  mkdirSync(input.privateDir, { recursive: true, mode: 0o700 })
  const receiptDir = mkdtempSync(join(input.privateDir, 'github-receipt-'))
  try {
    const env: NodeJS.ProcessEnv = { NODE_ENV: input.env?.NODE_ENV ?? process.env.NODE_ENV ?? 'production', ...input.env,
      ...(input.hosted ? {
        GH_HOST: 'github.com', GH_TOKEN: '', GITHUB_TOKEN: '', GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_1: '!gh auth git-credential',
      } : prepareGitHubEnvironment(receiptDir, input.github, input.env?.PATH ?? process.env.PATH ?? '')) }
    const git = await pinnedGit(input.repoPath, input.worktree, env)
    const originalHead = String((await git(['rev-parse', 'HEAD'])).stdout).trim()
    if (await snapshotTree(input.repoPath, input.worktree, env) !== input.tree) throw new Error('Agent must commit and verify every change before submitting')
    const url = `https://github.com/${input.github.repository}.git`
    const commit = String((await git(['ls-remote', '--exit-code', url, `refs/heads/${branch}`])).stdout).trim().split(/\s+/)[0]
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid pushed commit')
    const headTree = String((await git(['rev-parse', 'HEAD^{tree}'])).stdout).trim()
    if (originalHead !== commit || headTree !== input.tree) throw new Error('Agent must commit and verify every change before submitting')
    try {
      const gh = (args: string[]) => execa(input.hosted ? 'gh' : join(receiptDir, 'github', 'bin', 'gh'), args, { cwd: input.worktree, env, extendEnv: false, stdin: 'ignore' })
      const [owner, repository] = input.github.repository.split('/')
      const query = 'query($owner:String!,$repository:String!,$commit:GitObjectID!){repository(owner:$owner,name:$repository){object(oid:$commit){... on Commit {oid statusCheckRollup{state}}}}}'
      // These reads share the fixed remote SHA. Settle every child before
      // removing its private credential helper, including when one fails.
      const [pr, checks] = await Promise.allSettled([
        gh(['pr', 'view', branch, '--repo', input.github.repository, '--json', 'headRefOid,body']).then(result => JSON.parse(result.stdout)),
        gh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `repository=${repository}`, '-f', `commit=${commit}`]).then(result => JSON.parse(result.stdout)),
      ])
      if (pr.status === 'rejected' || checks.status === 'rejected') throw new Error('GitHub receipt lookup failed')
      if (pr.value.headRefOid !== commit || typeof pr.value.body !== 'string' || !pr.value.body.trimEnd().endsWith(`<!-- mikka-issue:${input.github.issueId} -->`)) throw new Error('Unbound pull request')
      const checked = checks.value.data?.repository?.object
      if (checked?.oid !== commit || checked.statusCheckRollup?.state !== 'SUCCESS') throw new Error('Incomplete CI')
    } catch { throw new Error('The task pull request and successful CI must match the submitted commit') }
    return { branch, commit, pushed: true, remote: 'origin' }
  } finally { rmSync(receiptDir, { recursive: true, force: true }) }
}
