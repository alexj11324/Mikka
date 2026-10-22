// Target validation for the SSH connect flow, kept apart from the process
// code so it can be tested on its own. `ssh` parses an argument that starts
// with `-` as an option — `-oProxyCommand=…` runs a command on this server —
// so a target built from a form is validated, never trusted.

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/
const PORT_PATTERN = /^[0-9]{1,5}$/

/**
 * `[user@]host[:port]`, validated. Returns null for anything that is not a
 * plain hostname, IPv4 address or user name, so an option-looking host or a
 * host with shell metacharacters never reaches `ssh` or `rsync`.
 */
export function parseSshTarget(host: string, user: string): string | null {
  const rawHost = host.trim()
  const rawUser = user.trim()
  if (!rawHost || rawHost.startsWith('-') || /\s/.test(rawHost)) return null
  if (rawUser && (rawUser.startsWith('-') || !NAME_PATTERN.test(rawUser))) return null
  const parts = rawHost.split(':')
  if (parts.length > 2) return null
  const [name, port] = parts
  if (!name || !NAME_PATTERN.test(name)) return null
  if (port !== undefined && !PORT_PATTERN.test(port)) return null
  return rawUser ? `${rawUser}@${rawHost}` : rawHost
}

/** A target that reached `ssh` without validation never runs. */
export function isSafeTarget(target: string): boolean {
  return target.length > 0 && !target.startsWith('-') && !/\s/.test(target)
}
