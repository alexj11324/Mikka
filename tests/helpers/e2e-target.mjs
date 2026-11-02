// One rule for every DB test: a loopback Postgres whose database name ends in
// `_e2e`, on any port, with no URL options. CI is not required; anything else
// (shared, preview or production databases) is refused before connecting.
export const E2E_DB_RULE = 'DB tests require a loopback Postgres database whose name ends in _e2e, without URL options'

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]']

/**
 * Parse exactly what pg's connection-string parser would connect to. pg reads
 * host/database from the URL (decoded) and lets query params such as ?host=
 * override them, so options are refused outright and the decoded values are
 * re-checked.
 */
export function e2eTargetParts(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value) return null
  let u
  try { u = new URL(value) } catch { return null }
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) return null
  if (u.search || u.hash || value.includes('?') || value.includes('#')) return null
  let host, database
  try { host = decodeURIComponent(u.hostname); database = decodeURIComponent(u.pathname.slice(1)) } catch { return null }
  if (!LOOPBACK.includes(host)) return null
  if (!/^[A-Za-z0-9_]+_e2e$/.test(database)) return null
  return { host, database }
}

export function isE2eTarget(value) {
  return e2eTargetParts(value) !== null
}

export function assertE2eTarget(value) {
  if (!isE2eTarget(value)) throw new Error(E2E_DB_RULE)
  return new URL(value)
}

// Every application database URL a test process can reach through lib/db and
// friends. A set one that is not a loopback *_e2e target disqualifies the run.
export const APPLICATION_DATABASE_URLS = ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL', 'ORVILO_DATABASE_URL']

/**
 * Whether a DB test may write: the URLs it connects to (E2E_DATABASE_URL by
 * default) and every application database URL set in env are loopback *_e2e
 * databases. Decided by the database alone, so CI and a developer's own
 * disposable database pass alike; a remote or non-_e2e URL anywhere fails.
 */
export function disposableDatabase(env = process.env, ...urls) {
  const targets = urls.length ? urls : [env.E2E_DATABASE_URL]
  if (!targets.every(isE2eTarget)) return false
  return APPLICATION_DATABASE_URLS.every(name => !env[name] || isE2eTarget(env[name]))
}
