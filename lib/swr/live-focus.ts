type ConnectionCheck = () => boolean | undefined
const readers = new WeakMap<object, Map<string, Set<ConnectionCheck>>>()

/** Register live coverage against the provider, so another account or workspace
 * cannot make this key look connected. Checks read transport state on focus. */
export function registerLiveKeyConnection(cache: object, keys: readonly string[], check: ConnectionCheck): () => void {
  let entries = readers.get(cache)
  if (!entries) { entries = new Map(); readers.set(cache, entries) }
  const scoped = entries
  for (const key of keys) {
    let checks = scoped.get(key)
    if (!checks) { checks = new Set(); scoped.set(key, checks) }
    checks.add(check)
  }
  return () => {
    for (const key of keys) {
      const checks = scoped.get(key)
      checks?.delete(check)
      if (!checks?.size) scoped.delete(key)
    }
  }
}

export function liveKeyConnection(cache: object, key: string): boolean | undefined {
  const checks = readers.get(cache)?.get(key)
  if (!checks?.size) return undefined
  let connected: boolean | undefined
  for (const check of checks) {
    const value = check()
    if (value === false) return false
    if (value === true) connected = true
  }
  return connected
}
