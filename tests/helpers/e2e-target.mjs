// One rule for every DB test: a loopback Postgres whose database name ends in
// `_e2e`, on any port, with no URL options. CI is not required; anything else
// (shared, preview or production databases) is refused before connecting.
export const E2E_DB_RULE = 'DB tests require a loopback Postgres database whose name ends in _e2e, without URL options'

export function isE2eTarget(value) {
  let u
  try { u = new URL(value ?? '') } catch { return false }
  return ['postgres:', 'postgresql:'].includes(u.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    && /^\/[A-Za-z0-9_]+_e2e$/.test(u.pathname)
    && !u.search && !u.hash
}

export function assertE2eTarget(value) {
  if (!isE2eTarget(value)) throw new Error(E2E_DB_RULE)
  return new URL(value)
}
