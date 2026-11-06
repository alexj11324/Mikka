// Local tasks keep the person's native gh login untouched. A private native
// gh config holds this run's prepared credential; only its background expiry
// timer talks to Mikka. Git, gh and a long-running gh watch use the real CLI.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { RunAssignment } from '@mikka/protocol'
import type { ServerLink } from '../server-link'
import { runRuntimeTimings } from '../run-runtime-timing'
import { prepareMachineGitHub } from './machine-github'
import { GITHUB_CREDENTIAL_SCRIPT } from './github-runtime'
import { findOnPath } from '../path-search'

export interface PreparedRunGitHub {
  /** No tokens: native gh reads its current hosts.yml on each invocation. */
  env: Record<string, string>
  close(): void
}

export async function prepareLocalGitHub(assignment: RunAssignment, host: {
  stateDir: string
  link: Pick<ServerLink, 'githubLease'>
  signal: AbortSignal
  onCredential(name: string, value: string): void
  onRefreshError?(): void
  path?: string
}): Promise<PreparedRunGitHub | undefined> {
  if (!assignment.github) return undefined
  const lease = async () => {
    if (host.signal.aborted || !host.link.githubLease) throw Error('github_credential_unavailable')
    return host.link.githubLease(assignment.deviceId, assignment.runId, host.signal)
  }
  if (host.signal.aborted) throw Error('github_run_closed')
  const path = host.path ?? process.env.PATH ?? ''
  const binary = findOnPath('gh', path)
  const credential = assignment.github.token
    ? { token: assignment.github.token, expiresAt: assignment.github.expiresAt ?? null }
    : await lease() // Restart/old claim: acquire once during preparation.
  if (host.signal.aborted) throw Error('github_run_closed')
  mkdirSync(host.stateDir, { recursive: true, mode: 0o700 })
  const directory = mkdtempSync(join(host.stateDir, 'github-'))
  try {
    const bin = join(directory, 'bin')
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const helper = `${process.versions.electron ? 'env ELECTRON_RUN_AS_NODE=1 ' : ''}${quote(process.execPath)} ${quote(GITHUB_CREDENTIAL_SCRIPT)}`
    if (binary) {
      mkdirSync(bin, { mode: 0o700 })
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec ${helper} native-gh ${quote(binary)} ${quote(directory)} "$@"\n`, { mode: 0o700, flag: 'wx' })
    }
    const prepared = prepareMachineGitHub({ ...assignment.github, ...credential, issueId: assignment.issueId }, {
      env: { HOME: homedir(), GH_CONFIG_DIR: directory },
      signal: host.signal,
      refresh: () => runRuntimeTimings.backgroundCredentialRefresh(assignment.runId, lease),
      onCredential: host.onCredential,
      onRefreshError: host.onRefreshError,
    })
    return {
      env: { ...prepared.env, GH_CONFIG_DIR: directory, PATH: binary ? `${bin}${delimiter}${path}` : path,
        ...(!binary ? { GIT_CONFIG_VALUE_1: `!${helper} prepared-git ${quote(directory)}` } : {}),
        GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_2: 'commit.gpgSign', GIT_CONFIG_VALUE_2: 'false',
        GIT_CONFIG_KEY_3: 'tag.gpgSign', GIT_CONFIG_VALUE_3: 'false',
        GIT_AUTHOR_NAME: 'Mikka Agent', GIT_AUTHOR_EMAIL: 'agent@mikka.invalid',
        GIT_COMMITTER_NAME: 'Mikka Agent', GIT_COMMITTER_EMAIL: 'agent@mikka.invalid',
      },
      close() {
        prepared.close()
        rmSync(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
