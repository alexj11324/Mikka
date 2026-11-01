// Run-local credentials only. The App key and the daemon's credentials never
// enter this process. stdout in `git` mode is the git credential protocol.
import { readFile, writeFile, rename, lstat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MAX_CACHE_AGE = 50 * 60_000

export function matchesGitRepository(input, repository) {
  return input.protocol === 'https' && input.host === 'github.com' &&
    [repository, `${repository}.git`].some(path => input.path?.toLowerCase() === path.toLowerCase())
}

/** Status and the server's fixed code only, so the agent can say why; never a response body. */
export class RunGitHubCredentialsError extends Error {
  constructor(status, reason) {
    super('Run GitHub credentials unavailable')
    this.detail = `${status}${typeof reason === 'string' && /^[a-z_]+$/.test(reason) ? ` ${reason}` : ''}`
  }
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
  if (!response.ok) {
    const reason = await response.json().then(body => body?.reason, () => undefined)
    throw new RunGitHubCredentialsError(response.status, reason)
  }
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
  main().catch(error => { process.stderr.write(`Mikka GitHub credentials or CI status unavailable${error instanceof RunGitHubCredentialsError ? ` (${error.detail})` : ''}.\n`); process.exitCode = 1 })
}
