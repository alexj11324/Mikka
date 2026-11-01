// Pure helpers for the test-account harness. No database driver or network access here.
// The local-mode rule itself lives in packages/protocol/src/local-test-mode.ts.
import { localTestDatabaseUrl } from '../../packages/protocol/src/local-test-mode.ts'

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/

export class EnvironmentError extends Error {
  constructor(code) { super(code); this.name = 'EnvironmentError'; this.code = code }
}
const fail = code => { throw new EnvironmentError(code) }

/** Deliberately never include a URL, driver error, password or response body in errors. */
export function databaseTarget(connectionString) {
  let target
  try { target = new URL(connectionString) } catch { fail('DATABASE_URL_REQUIRED') }
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.search || target.hash || !target.username || !target.password) fail('DATABASE_URL_INVALID')
  const name = target.pathname.slice(1)
  if (!IDENTIFIER.test(name) || !IDENTIFIER.test(decodeURIComponent(target.username))) fail('DATABASE_TARGET_INVALID')
  return { host: target.hostname, port: Number(target.port || 5432), name, schema: 'public', user: decodeURIComponent(target.username) }
}

/** A developer's own disposable database: loopback host and a *_e2e name. */
export function localDatabaseTarget(connectionString) {
  const target = databaseTarget(connectionString)
  if (!localTestDatabaseUrl(connectionString)) fail('LOCAL_DATABASE_REQUIRED')
  return target
}
