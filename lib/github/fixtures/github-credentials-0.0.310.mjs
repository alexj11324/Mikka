// Daemon 0.0.310 (d7507fb6), as installed on people's computers: kept to test that the
// server's run GitHub token answer still works for daemons released before #1023.
// Do not edit; it is the released code.
// Run-local credentials only. The App key and the daemon's credentials never
// enter this process. stdout in `git` mode is the git credential protocol.
import { readFile, writeFile, rename, lstat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MAX_CACHE_AGE = 50 * 60_000

/**
 * The server's reason a run's GitHub token was not issued, in words a person
 * can act on, English then Chinese. Only these known codes are shown; any
 * other response says GitHub credentials are unavailable.
 */
export const RUN_GITHUB_ERROR_MESSAGES = {
  githubAppNotConfigured: ['The Mikka GitHub App is not set up on this Mikka server.', '这台 Mikka 服务器还没有配置 Mikka GitHub App。'],
  githubIdentityRequired: ['Connect a GitHub account in Mikka (Plugins › GitHub) to work on this repository.', '在 Mikka 的插件 › GitHub 里连接一个 GitHub 账号后，才能处理这个仓库。'],
  githubAppNotInstalled: ['Install the Mikka GitHub App on this repository.', '这个仓库还没有安装 Mikka GitHub App。'],
  githubAppSuspended: ['The Mikka GitHub App is suspended on this repository.', 'Mikka GitHub App 在这个仓库上已被暂停。'],
  githubAppPermissionRequired: ['Give the Mikka GitHub App pull request write and contents read access on this repository.', 'Mikka GitHub App 在这个仓库上缺少 Pull request 写权限或 Contents 读权限。'],
  githubAccountNoWriteAccess: ['Your connected GitHub account cannot write to this repository.', '你连接的 GitHub 账号没有这个仓库的写权限。'],
  githubRepositoryNotSupported: ['Only github.com repositories are supported.', '目前只支持 github.com 上的仓库。'],
  githubRateLimited: ['GitHub is rate limiting requests. Try again in a few minutes.', 'GitHub 暂时限流，几分钟后再试。'],
  runGitHubUnavailable: ['GitHub is unavailable right now. Try again later.', 'GitHub 暂时不可用，稍后再试。'],
  runGitHubAccessDenied: ['This run can no longer use GitHub: it ended or changed repository.', '这个线程已结束或换了仓库，不能再使用 GitHub。'],
}

/** A failed token exchange, carrying only the server's known error code. */
export class RunGitHubCredentialError extends Error {
  constructor(code) {
    super('Run GitHub credentials unavailable')
    this.name = 'RunGitHubCredentialError'
    this.code = Object.hasOwn(RUN_GITHUB_ERROR_MESSAGES, code) ? code : null
  }
}

/** The lines a person sees on stderr for a failure; never a response body. */
export function credentialFailureMessage(error) {
  const lines = error instanceof RunGitHubCredentialError && error.code ? RUN_GITHUB_ERROR_MESSAGES[error.code] : null
  return lines ? `Mikka: ${lines[0]}\nMikka：${lines[1]}\n` : 'Mikka GitHub credentials or CI status unavailable.\n'
}

async function errorCode(response) {
  try {
    const body = await response.json()
    return typeof body?.error === 'string' ? body.error : null
  } catch { return null }
}

export function matchesGitRepository(input, repository) {
  return input.protocol === 'https' && input.host === 'github.com' &&
    [repository, `${repository}.git`].some(path => input.path?.toLowerCase() === path.toLowerCase())
}

export async function getRunGitHubToken(config, { fetcher = fetch, now = Date.now, minValidityMs = 60_000 } = {}) {
  const cachePath = `${config.file}.cache`
  try {
    const stat = await lstat(cachePath)
    if (stat.isFile() && (stat.mode & 0o077) === 0) {
      const cached = JSON.parse(await readFile(cachePath, 'utf8'))
      if (cached.repository === config.repository && cached.token &&
        cached.createdAt <= now() && now() - cached.createdAt < MAX_CACHE_AGE && Date.parse(cached.expiresAt) - now() > minValidityMs) return cached.token
    }
  } catch { /* No reusable run-local token. */ }
  const response = await fetcher(config.endpoint, {
    method: 'POST', redirect: 'error', cache: 'no-store',
    headers: { authorization: `Bearer ${config.runToken}` }, signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new RunGitHubCredentialError(await errorCode(response))
  const result = await response.json()
  if (result.repository?.toLowerCase() !== config.repository.toLowerCase() || typeof result.token !== 'string' || !result.token ||
    !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) - now() <= minValidityMs) throw new Error('Invalid run GitHub credentials')
  const temporary = `${cachePath}.${randomUUID()}`
  await writeFile(temporary, JSON.stringify({ ...result, createdAt: now() }), { mode: 0o600, flag: 'wx' })
  await rename(temporary, cachePath)
  return result.token
}

const WATCH_SEGMENT_MS = 40 * 60_000

function cli(config, args, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.gh, args, {
      env: { ...process.env, GH_HOST: 'github.com', GH_TOKEN: token, GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '', GH_PROMPT_DISABLED: '1' },
      stdio: 'inherit',
    })
    let timedOut = false, hardStop
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      hardStop = setTimeout(() => child.kill('SIGKILL'), 2000)
      hardStop.unref()
    }, timeoutMs) : undefined
    timer?.unref()
    const clear = () => { clearTimeout(timer); clearTimeout(hardStop) }
    child.on('error', () => { clear(); reject(new Error('GitHub CLI could not start')) })
    child.on('close', code => { clear(); resolve({ code: code ?? 1, timedOut }) })
  })
}

/** Native gh owns check semantics, output and --required/--fail-fast flags.
 * Renew only the read-only watch process before its token can expire. This
 * also works with gh versions predating `pr checks --json` support. */
export async function runGh(config, args, deps = {}) {
  const watch = args[0] === 'pr' && args[1] === 'checks' && args.includes('--watch')
  const token = deps.token ?? (minValidityMs => getRunGitHubToken(config, { minValidityMs }))
  const invoke = deps.invoke ?? ((args, token, timeoutMs) => cli(config, args, token, timeoutMs))
  for (;;) {
    const credential = await token(watch ? WATCH_SEGMENT_MS + 60_000 : 60_000)
    const result = await invoke(args, credential, watch ? WATCH_SEGMENT_MS : undefined)
    if (!watch || !result.timedOut) return result.code
  }
}

async function main() {
  const [mode, file, ...args] = process.argv.slice(2)
  const config = { ...JSON.parse(await readFile(file, 'utf8')), file }
  if (mode === 'git') {
    if (args[0] !== 'get') return
    let text = ''
    for await (const chunk of process.stdin) {
      text += chunk
      if (text.length > 8192) throw new Error('Invalid git credential request')
    }
    const input = Object.fromEntries(text.trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
    if (!matchesGitRepository(input, config.repository)) return
    process.stdout.write(`username=x-access-token\npassword=${await getRunGitHubToken(config)}\n\n`)
  } else if (mode === 'gh') process.exitCode = await runGh(config, args)
  else throw new Error('Invalid credential helper mode')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(credentialFailureMessage(error)); process.exitCode = 1 })
}
