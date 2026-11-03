import { randomUUID } from 'node:crypto'

/**
 * The Bot owner's own GitHub credential for git and gh on a Bot's cloud desktop
 * (decision 2026-11-02-1600), like `gh auth login` on their own computer. The
 * helper asks the server with the desktop worker's existing device credential
 * (read from the worker's device file each time, so a rotation is followed) and
 * keeps the answer only in a 0600 cache for at most fifty minutes; that cache is
 * a snapshot credential path (packages/daemon/src/credential-globs.ts). No token
 * is in argv, the environment of git, or any file but that cache.
 */
export const DESKTOP_GITHUB_DIR = '/home/user/.mikka/github'
export const DESKTOP_GITHUB_HELPER = `${DESKTOP_GITHUB_DIR}/credential.mjs`
export const DESKTOP_WORKER_DEVICE_FILE = '/home/user/.mikka/worker/device.json'
const NODE = '/usr/local/bin/node'
const REAL_GH = '/usr/bin/gh'
const GH_WRAPPER = '/usr/local/bin/gh'

/** Self-contained; run by the desktop's own Node as `user`. stdout in `git` mode is the git credential protocol. */
export const DESKTOP_GITHUB_HELPER_SOURCE = String.raw`// Mikka: the Bot owner's own GitHub credential for git and gh on this desktop.
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const MAX_CACHE_AGE = 50 * 60_000
const MESSAGES = {
  githubNotConnected: 'Mikka: connect GitHub in Mikka (Plugins › GitHub).',
  githubReconnectRequired: 'Mikka: reconnect GitHub in Mikka (Plugins › GitHub).',
}

async function token(config, minValidityMs) {
  const cache = join(dir, 'token.json')
  try {
    const stat = lstatSync(cache)
    if (stat.isFile() && (stat.mode & 0o077) === 0) {
      const cached = JSON.parse(readFileSync(cache, 'utf8'))
      const now = Date.now()
      if (cached.token && cached.createdAt <= now && now - cached.createdAt < MAX_CACHE_AGE && Date.parse(cached.expiresAt) - now > minValidityMs) return cached.token
    }
  } catch { /* nothing reusable */ }
  const device = JSON.parse(readFileSync(config.deviceFile, 'utf8'))
  if (device.deviceId !== config.deviceId || typeof device.credential !== 'string') throw new Error('unavailable')
  const response = await fetch(config.endpoint, {
    method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    headers: { authorization: 'Bearer ' + device.credential, ...(config.protectionBypass ? { 'x-vercel-protection-bypass': config.protectionBypass } : {}) },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof body?.error === 'string' && Object.hasOwn(MESSAGES, body.error) ? body.error : 'unavailable')
  if (typeof body?.token !== 'string' || !body.token || !(Date.parse(body.expiresAt) - Date.now() > minValidityMs)) throw new Error('unavailable')
  const temporary = cache + '.' + randomUUID()
  writeFileSync(temporary, JSON.stringify({ token: body.token, expiresAt: body.expiresAt, createdAt: Date.now() }), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, cache)
  return body.token
}

async function main() {
  const [mode, ...args] = process.argv.slice(2)
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  if (mode === 'git') {
    if (args[0] !== 'get') return
    let text = ''
    for await (const chunk of process.stdin) { text += chunk; if (text.length > 8192) throw new Error('unavailable') }
    const input = Object.fromEntries(text.trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
    if (input.protocol !== 'https' || input.host !== 'github.com') return
    process.stdout.write('username=x-access-token\npassword=' + await token(config, 60_000) + '\n\n')
  } else if (mode === 'gh') {
    // A run's own credential (its run-local wrapper) is kept as given.
    const env = process.env.GH_TOKEN ? process.env : { ...process.env, GH_HOST: 'github.com', GH_TOKEN: await token(config, 60_000), GITHUB_TOKEN: '', GH_PROMPT_DISABLED: '1' }
    const child = spawn(config.gh, args, { env, stdio: 'inherit' })
    child.on('error', () => { process.stderr.write('Mikka: GitHub CLI could not start.\n'); process.exitCode = 1 })
    child.on('close', code => { process.exitCode = code ?? 1 })
  } else throw new Error('unavailable')
}

main().catch(error => { process.stderr.write((MESSAGES[error?.message] ?? 'Mikka: GitHub credentials unavailable.') + '\n'); process.exitCode = 1 })
`

/** The non-secret helper settings: where to ask, as which desktop device. */
export function desktopGitHubConfig(server: string, deviceId: string, protectionBypass?: string) {
  const base = server.replace(/\/+$/, '')
  return { endpoint: `${base}/v1/devices/${encodeURIComponent(deviceId)}/github-token`, deviceId, deviceFile: DESKTOP_WORKER_DEVICE_FILE, gh: REAL_GH, ...(protectionBypass ? { protectionBypass } : {}) }
}

type Sandbox = {
  files: { write(path: string, data: string, options: { user: 'root' }): Promise<unknown> }
  commands: { run(command: string, options: { user: 'root' | 'user'; timeoutMs: number }): Promise<unknown> }
}

/**
 * Written as root to a root-only staging directory, then installed for `user`
 * (0600 files in a 0700 directory). The gh wrapper and git's credential helper
 * setting hold no secret. Nothing here appears in a command line but paths.
 */
export async function installDesktopGitHub(sandbox: Sandbox, config: ReturnType<typeof desktopGitHubConfig>) {
  const stage = `/run/mikka-viewer/github-${randomUUID()}`
  const wrapper = `#!/bin/sh\nexec ${NODE} ${DESKTOP_GITHUB_HELPER} gh "$@"\n`
  try {
    await sandbox.files.write(`${stage}.mjs`, DESKTOP_GITHUB_HELPER_SOURCE, { user: 'root' })
    await sandbox.files.write(`${stage}.json`, JSON.stringify(config), { user: 'root' })
    await sandbox.files.write(`${stage}.gh`, wrapper, { user: 'root' })
    await sandbox.commands.run([
      `install -d -o user -g user -m 0700 /home/user/.mikka ${DESKTOP_GITHUB_DIR}`,
      `install -o user -g user -m 0600 ${stage}.mjs ${DESKTOP_GITHUB_HELPER}`,
      `install -o user -g user -m 0600 ${stage}.json ${DESKTOP_GITHUB_DIR}/config.json`,
      `install -o root -g root -m 0755 ${stage}.gh ${GH_WRAPPER}`,
      `rm -f ${DESKTOP_GITHUB_DIR}/token.json`,
    ].join(' && '), { user: 'root', timeoutMs: 10_000 })
    await sandbox.commands.run(`git config --global --replace-all credential.https://github.com.helper '!${NODE} ${DESKTOP_GITHUB_HELPER} git'`, { user: 'user', timeoutMs: 10_000 })
  } finally {
    await sandbox.commands.run(`rm -f ${stage}.mjs ${stage}.json ${stage}.gh`, { user: 'root', timeoutMs: 10_000 }).catch(() => undefined)
  }
}
