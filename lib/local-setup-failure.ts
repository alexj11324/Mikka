import { CodedError } from '@mikka/protocol/coded-error'
import type { LocalSetupFailureDetail } from '@mikka/protocol/bridge'

/**
 * Why adding a computer failed, read from what its commands wrote to stderr.
 * npm prints deprecation and engine warnings before its real error; those are
 * noise. The detail picks the person-facing copy (RunErrors.desktop_local_setup_failed.*),
 * `summary` is the real error line(s) and `log` the whole output for 详情.
 */
export const LOCAL_SETUP_FAILED = 'desktop_local_setup_failed'

export interface SetupFailure {
  detail: LocalSetupFailureDetail
  /** The real error line(s), without npm warnings. Shown when no copy fits. */
  summary: string
  /** Values the copy names: required/found Node, the path npm could not write. */
  values: Record<string, string>
  /** The command's whole output, for the expandable log. */
  log: string
}

/** A command that exited non-zero, with its complete stderr (bounded). */
export class CommandFailed extends Error {
  constructor(readonly exitCode: number | null, readonly stderr: string) {
    super(firstRealError(stderr) || `Command failed (${exitCode})`)
    this.name = 'CommandFailed'
  }
}

const NOISE = [
  /^npm (?:warn|notice|WARN|verb|http|timing|info)\b/,
  /^\(node:\d+\) (?:\[[A-Z0-9]+\] )?\w*Warning:/,
  /^\(Use `node --trace-/,
  /\bdeprecated\b/i,
]

/** stderr without empty lines, npm warnings and Node deprecation notices. */
export function realErrorLines(stderr: string): string[] {
  return stderr.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim() && !NOISE.some(rule => rule.test(line.trim())))
}

/** The lines a person should read first: npm's own error block, else the first real lines. */
export function firstRealError(stderr: string, max = 3): string {
  const lines = realErrorLines(stderr)
  const npm = lines.filter(line => /^npm (?:error|ERR!)/.test(line))
    .map(line => line.replace(/^npm (?:error|ERR!)\s*/, '').trim())
    .filter(line => line && !/^(?:A complete log of this run|Log files were not written|You can rerun the command)/.test(line))
  return (npm.length ? npm : lines.map(line => line.trim())).slice(0, max).join('\n').slice(0, 600)
}

const NODE_CHECK = /Node\.js >=(\d+) required(?: \((?:found v?([0-9][0-9.]*)(?: at (\S+))?|(node not found))\))?/

/** Classify one failure. Messages main itself throws keep their exact text. */
export function classifySetupFailure(error: unknown): SetupFailure {
  const stderr = error instanceof CommandFailed ? error.stderr : ''
  const message = error instanceof Error ? error.message : String(error ?? '')
  const text = stderr || message
  const summary = (error instanceof CommandFailed ? firstRealError(stderr) : message) || message
  const log = stderr.trim()
  const done = (detail: LocalSetupFailureDetail, values: Record<string, string> = {}): SetupFailure => ({ detail, summary, values, log })

  if (message === 'cancelled') return done('cancelled')
  if (message === 'SSH operation timed out') return done('timeout')
  if (message === 'Device did not come online within 30 seconds') return done('online_timeout')
  if (message === 'Device does not belong to the signed-in account') return done('owner_mismatch')
  if (message === 'Device account could not be confirmed') return done('owner_unconfirmed')
  if (/Linux or macOS required/.test(text)) return done('unsupported_os')
  const node = NODE_CHECK.exec(text)
  if (node) {
    if (node[4] || !node[2]) return done('node_missing', { required: node[1] })
    return done('node_too_old', { required: node[1], found: node[2].split('.')[0], path: node[3] ?? '' })
  }
  if (/\bENOTEMPTY\b/.test(text)) return done('npm_directory_not_empty', { path: npmPath(text, /ENOTEMPTY[^']*'([^']+)'/) })
  if (/\b(?:EACCES|EPERM)\b/.test(text)) return done('npm_permission', { path: npmPath(text, /^npm (?:error|ERR!) path (\S+)/m) })
  if (/\bE404\b/.test(text)) return done('npm_package_not_found')
  const network = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ECONNABORTED|EPROTO|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)\b/.exec(text)
  if (network) return done('network', { code: network[1] })
  if (/(?:command not found: mikka|mikka: (?:command )?not found)/.test(text)) return done('command_missing')
  if (/Bootstrap failed:|Failed to connect to (?:user scope )?bus/.test(text)) return done('service_failed')
  return done('other')
}

function npmPath(text: string, rule: RegExp) {
  return rule.exec(text)?.[1] ?? ''
}

/** The coded error the installer reports, keeping what failed as its cause. */
export function setupError(error: unknown) {
  const failure = classifySetupFailure(error)
  return { error: new CodedError(LOCAL_SETUP_FAILED, { detail: failure.detail, cause: error }), failure }
}
