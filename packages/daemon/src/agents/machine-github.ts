// One cloud task owns the machine. Use the normal gh credential file and the
// actual gh binary; neither git nor gh exchanges a run token on each command.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { RunGitHub } from './github-runtime'

export interface GitHubCredential { token: string; expiresAt: string | null }

/** gh writes a flat map of host blocks. Keep every other host's block intact. */
export function githubHosts(contents: string, token: string): string {
  if (!token || /[\r\n\0]/.test(token) || token.length > 32768) throw Error('github_credential_invalid')
  const lines = contents.split(/\r?\n/)
  const start = lines.findIndex(line => /^(?:github\.com|"github\.com"|'github\.com'):\s*(?:#.*)?$/.test(line))
  if (start >= 0) {
    let end = start + 1
    while (end < lines.length && (!lines[end].trim() || /^[\t ]/.test(lines[end]))) end++
    lines.splice(start, end - start)
  } else if (contents.trimStart().startsWith('{')) {
    // JSON is YAML, and is occasionally used by provisioning tools.
    const value = JSON.parse(contents) as Record<string, unknown>
    return JSON.stringify({ ...value, 'github.com': { oauth_token: token, git_protocol: 'https' } }) + '\n'
  } else if (/^(?:github\.com|"github\.com"|'github\.com'):/m.test(contents)) {
    throw Error('github_configuration_invalid')
  }
  const kept = lines.join('\n').trimEnd()
  return `${kept ? kept + '\n' : ''}github.com:\n    oauth_token: ${JSON.stringify(token)}\n    git_protocol: https\n`
}

export function prepareMachineGitHub(github: RunGitHub, host: {
  env: Record<string, string>
  signal: AbortSignal
  refresh(): Promise<GitHubCredential>
  onCredential?(name: string, value: string): void
  onRefreshError?(): void
}) {
  if (!github.token) throw Error('github_credential_missing')
  const home = host.env.HOME
  if (!home) throw Error('github_home_missing')
  const directory = host.env.GH_CONFIG_DIR ?? join(host.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'gh')
  const file = join(directory, 'hosts.yml')
  const original = existsSync(file) ? readFileSync(file, 'utf8') : undefined
  let written: string | undefined
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: GitHubCredential = { token: github.token, expiresAt: github.expiresAt ?? null }
  let attemptedExpiry: string | null | undefined
  let failures = 0
  const write = (credential: GitHubCredential) => {
    if (credential.expiresAt !== null && (!Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt) <= Date.now()))
      throw Error('github_credential_expired')
    host.onCredential?.('GITHUB_TOKEN', credential.token)
    const latest = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const next = githubHosts(latest, credential.token)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}`
    writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
    written = next
  }
  const at = (due: number) => {
    clearTimeout(timer)
    if (closed || host.signal.aborted) return
    timer = setTimeout(() => {
      if (due > Date.now()) at(due)
      else void refresh()
    }, Math.min(2 ** 31 - 1, Math.max(0, due - Date.now())))
    timer.unref?.()
  }
  const schedule = () => {
    if (current.expiresAt === null) return
    at(Date.parse(current.expiresAt) - (attemptedExpiry === current.expiresAt ? 0 : 30_000))
  }
  async function refresh() {
    attemptedExpiry = current.expiresAt
    try {
      const credential = await host.refresh()
      if (closed || host.signal.aborted) return
      write(credential)
      current = credential
      failures = 0
      schedule()
    } catch {
      if (closed || host.signal.aborted) return
      host.onRefreshError?.()
      failures++
      if (failures <= 3) at(Date.now() + failures * 5_000)
    }
  }
  const close = (options?: { retainCredential?: boolean }) => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    host.signal.removeEventListener('abort', stopRefresh)
    // Never erase a person's later manual change. The ordinary credential
    // file is reclaimed with the VM if it no longer matches our last write.
    if (!options?.retainCredential && written !== undefined && existsSync(file) && readFileSync(file, 'utf8') === written) {
      if (original === undefined) rmSync(file, { force: true })
      else writeFileSync(file, original, { mode: 0o600 })
    }
    current = { token: '', expiresAt: null }
  }
  const stopRefresh = () => { clearTimeout(timer) }
  write(current)
  host.signal.addEventListener('abort', stopRefresh, { once: true })
  if (host.signal.aborted) close()
  else schedule()
  return {
    env: { ...MACHINE_GITHUB_ENV },
    close,
  }
}

/** Non-secret native Git configuration; credentials stay in the ordinary HOME file. */
export const MACHINE_GITHUB_ENV = {
      GH_HOST: 'github.com', GH_TOKEN: '', GITHUB_TOKEN: '', GIT_TERMINAL_PROMPT: '0',
      // These normal git overrides contain no token and use the normal gh
      // login file. The real provider credential is read locally by gh.
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_1: '!gh auth git-credential',
    }
