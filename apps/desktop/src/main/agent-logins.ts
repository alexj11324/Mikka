// Reads how this computer's official Claude Code and Codex CLIs are signed in,
// the way Capy's desktop does: `claude auth status --json` and
// `codex login status`. Fixed commands and arguments only, no renderer input;
// only the login kind and plan leave main, never a credential or account id.

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { AgentLogin, AgentLogins } from '@mikka/protocol/bridge'

const TIMEOUT_MS = 5_000
const MAX_OUTPUT = 65_536

interface Probe { missing: boolean; stdout: string; stderr: string }

/** GUI apps start with a short PATH; add where these CLIs usually install. */
export function agentSearchPath(current = process.env.PATH ?? '', platform = process.platform, home = homedir()): string {
  const extra = platform === 'win32' ? [] : [join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin']
  return [...new Set([...current.split(delimiter), ...extra])].filter(Boolean).join(delimiter)
}

function run(command: string, args: string[], path: string): Promise<Probe> {
  return new Promise(resolve => {
    execFile(command, args, {
      env: { ...process.env, PATH: path, NO_COLOR: '1' }, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT,
      windowsHide: true, shell: process.platform === 'win32',
    }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code
      const missing = code === 'ENOENT' || (process.platform === 'win32' && String(stderr).includes('is not recognized'))
      resolve({ missing, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

const PLAN = /^[A-Za-z0-9 ._-]{1,60}$/

/** `claude auth status --json`: { loggedIn, authMethod, subscriptionType }. */
export function parseClaudeStatus(probe: Probe): AgentLogin {
  if (probe.missing) return { login: 'missing', plan: null }
  try {
    const value = JSON.parse(probe.stdout.trim()) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown }
    if (typeof value.loggedIn !== 'boolean') return { login: 'unknown', plan: null }
    if (!value.loggedIn) return { login: 'signed-out', plan: null }
    if (value.authMethod === 'claude.ai' || value.authMethod === 'oauth_token') {
      const plan = typeof value.subscriptionType === 'string' && PLAN.test(value.subscriptionType) ? value.subscriptionType : null
      return { login: 'subscription', plan }
    }
    return { login: 'api-key', plan: null }
  } catch { return { login: 'unknown', plan: null } }
}

/** `codex login status` prints a sentence; it names no plan. */
export function parseCodexStatus(probe: Probe): AgentLogin {
  if (probe.missing) return { login: 'missing', plan: null }
  const text = `${probe.stdout}\n${probe.stderr}`
  if (text.includes('Logged in using ChatGPT')) return { login: 'subscription', plan: null }
  if (/api key/i.test(text)) return { login: 'api-key', plan: null }
  if (text.includes('Not logged in')) return { login: 'signed-out', plan: null }
  return { login: 'unknown', plan: null }
}

export async function agentLogins(): Promise<AgentLogins> {
  const path = agentSearchPath()
  const [claude, codex] = await Promise.all([
    run('claude', ['auth', 'status', '--json'], path),
    run('codex', ['login', 'status'], path),
  ])
  return { claudeCode: parseClaudeStatus(claude), codex: parseCodexStatus(codex) }
}
