import { createHash } from 'node:crypto'

const OWNER = "XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ"
const SMOKE = "cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3"
const WORKSPACE = "93f38d33-9447-4eaf-8a46-0d8889165bcd"
const ACCOUNT = '183887963'
const LOGIN = 'alexj11324'
const REPOSITORY = 'alexj11324/Mikka-handoff'
const codes = new Set(['fixture_mismatch', 'fixture_expired', 'connection_changed', 'token_changed', 'runtime_failed', 'read_failed', 'close_failed', 'preflight_failed', 'spawn_failed'])
const error = (code, cause) => new Error(`issue1503_ci_auth_${code}`, cause === undefined ? undefined : { cause })
const check = (value, code) => { if (!value) throw error(code) }
const iso = value => value instanceof Date ? value.toISOString() : value

export function ciAuthErrorCode(value) {
  const prefix = 'issue1503_ci_auth_'
  const code = value instanceof Error && value.message.startsWith(prefix) ? value.message.slice(prefix.length) : ''
  return `${prefix}${codes.has(code) ? code : 'preflight_failed'}`
}

export function validateCiCredentialFixture(fixture, now = Date.now()) {
  const state = fixture?.githubSetup
  check(fixture?.issue === 1503 && fixture.ownerUserId === OWNER && fixture.smokeUserId === SMOKE
    && fixture.workspaceId === WORKSPACE && state?.version === 1 && state.issue === 1503
    && state.userId === SMOKE && state.ownerUserId === OWNER && state.githubAccountId === ACCOUNT
    && state.githubLogin === LOGIN && state.repository === REPOSITORY
    && /^[a-f0-9]{64}$/.test(state.tokenSha256 ?? '')
    && Number.isFinite(Date.parse(state.connectionUpdatedAt)) && Number.isFinite(Date.parse(state.connectionExpiresAt))
    && Number.isFinite(Date.parse(state.providerExpiresAt))
    && Date.parse(state.connectionUpdatedAt) < Date.parse(state.connectionExpiresAt)
    && Date.parse(state.connectionExpiresAt) <= Date.parse(state.providerExpiresAt), 'fixture_mismatch')
  check(Date.parse(state.connectionExpiresAt) > now && Date.parse(state.providerExpiresAt) > now, 'fixture_expired')
  return state
}

export const ciCredentialSelect = `SELECT "userId","githubAccountId","githubLogin","accessToken",
  "accessTokenExpiresAt","updatedAt",("refreshToken" IS NULL) AS "refreshTokenMissing",
  ("refreshTokenExpiresAt" IS NULL) AS "refreshExpiryMissing"
  FROM github_connections
  WHERE "userId"=$1 AND "updatedAt"=$2::timestamptz AND "accessTokenExpiresAt"=$3::timestamptz
  LIMIT 1`

async function defaultRuntime() {
  let pool, workspacePool
  try {
    pool = (await import('../../../lib/db/index.ts')).pool
    workspacePool = (await import('../../../lib/workspace-db.ts')).workspacePool
    const { unsealGitHubSecret } = await import('../../../lib/github/connection.ts')
    return { query: (sql, params) => pool.query(sql, params), unseal: unsealGitHubSecret,
      close: () => Promise.all([pool.end(), workspacePool.end()]) }
  } catch (cause) {
    await Promise.allSettled([pool?.end(), workspacePool?.end()])
    throw error('runtime_failed', cause)
  }
}

// One read of the already authorized Smoke child, with its original expiry/CAS
// and fingerprint. No Owner lookup, provider refresh, mint, save or file output.
export async function loadCiGithubToken(fixture, { now = Date.now(), runtimeFactory = defaultRuntime } = {}) {
  const state = validateCiCredentialFixture(fixture, now)
  let runtime
  try {
    runtime = await runtimeFactory()
    const result = await runtime.query(ciCredentialSelect,
      [SMOKE, state.connectionUpdatedAt, state.connectionExpiresAt])
    const row = result.rows?.length === 1 ? result.rows[0] : null
    check(row?.userId === SMOKE && row.githubAccountId === ACCOUNT && row.githubLogin === LOGIN
      && row.refreshTokenMissing === true && row.refreshExpiryMissing === true
      && iso(row.updatedAt) === state.connectionUpdatedAt && iso(row.accessTokenExpiresAt) === state.connectionExpiresAt
      && typeof row.accessToken === 'string' && row.accessToken.length > 0, 'connection_changed')
    const token = await runtime.unseal(row.accessToken)
    check(typeof token === 'string' && token.length > 0
      && createHash('sha256').update(token).digest('hex') === state.tokenSha256, 'token_changed')
    return token
  } catch (cause) {
    if (cause instanceof Error && codes.has(cause.message.replace(/^issue1503_ci_auth_/, ''))
      && cause.message.startsWith('issue1503_ci_auth_')) throw cause
    throw error('read_failed', cause)
  } finally {
    if (runtime) {
      try { await runtime.close() } catch (cause) { throw error('close_failed', cause) }
    }
  }
}
