import 'server-only'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SshHost {
  alias: string
  hostName: string | null
  user: string | null
}

/**
 * The hosts in the server machine's `~/.ssh/config`, in file order. These are
 * the machines this app can reach without a password; the UI lists them the
 * way a terminal does.
 */
export async function listSshHosts(): Promise<SshHost[]> {
  let text: string
  try {
    text = await readFile(join(homedir(), '.ssh', 'config'), 'utf8')
  } catch {
    return []
  }
  const hosts: SshHost[] = []
  let current: SshHost | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [key, ...rest] = line.split(/\s+/)
    const value = rest.join(' ')
    const name = key.toLowerCase()
    if (name === 'host') {
      for (const alias of value.split(/\s+/)) {
        if (!alias || alias.includes('*') || alias.includes('?')) continue
        current = { alias, hostName: null, user: null }
        hosts.push(current)
      }
    } else if (current && name === 'hostname') current.hostName = value
    else if (current && name === 'user') current.user = value
  }
  return hosts
}

import { isSafeTarget } from './ssh-target'

export { parseSshTarget, isSafeTarget } from './ssh-target'

export interface SshResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * One non-interactive ssh command. `BatchMode` means a host that needs a
 * password fails immediately instead of hanging on a prompt.
 */
export function sshRun(target: string, command: string, timeoutMs = 60_000): Promise<SshResult> {
  if (!isSafeTarget(target)) return Promise.resolve({ code: 1, stdout: '', stderr: 'Refused an unsafe ssh target.' })
  return new Promise(resolve => {
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', target, command],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error ? 1 : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

/** `rsync -az` of one local path to a remote path; directories included. */
export function rsync(localPath: string, target: string, remotePath: string, extra: string[] = []): Promise<SshResult> {
  if (!isSafeTarget(target)) return Promise.resolve({ code: 1, stdout: '', stderr: 'Refused an unsafe ssh target.' })
  return new Promise(resolve => {
    execFile(
      'rsync',
      ['-az', '--delete', ...extra, '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10', localPath, `${target}:${remotePath}`],
      { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error ? 1 : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

/** The first line of output worth showing as a step's detail. */
export function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? ''
}
