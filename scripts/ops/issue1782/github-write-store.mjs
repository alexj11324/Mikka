import { createHash } from 'node:crypto'
import { SMOKE_USER_ID, OWNER_USER_ID, GITHUB_ACCOUNT_ID, GITHUB_LOGIN } from './github-write-provider.mjs'
import { check, lifetime, stateFor, validateState } from './github-write-helper.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const iso = value => value instanceof Date ? value.toISOString() : value
const COLUMNS = '"userId","githubAccountId","githubLogin","accessToken",("refreshToken" IS NOT NULL) AS "hasRefreshToken","accessTokenExpiresAt","refreshTokenExpiresAt","updatedAt"'
const active = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']
function sameOwner(row, source) {
  return row?.userId === OWNER_USER_ID && row.githubAccountId === GITHUB_ACCOUNT_ID && row.githubLogin === GITHUB_LOGIN
    && iso(row.updatedAt) === source.metadata.updatedAt && iso(row.accessTokenExpiresAt) === source.metadata.expiresAt
    && row.hasRefreshToken === source.metadata.hasRefreshToken && hash(row.accessToken) === source.sealedFingerprint
}
function matches(row, state) {
  return row?.userId === SMOKE_USER_ID && row.githubAccountId === GITHUB_ACCOUNT_ID && row.githubLogin === GITHUB_LOGIN
    && row.hasRefreshToken === false && row.refreshTokenExpiresAt === null
    && iso(row.updatedAt) === state.connectionUpdatedAt && iso(row.accessTokenExpiresAt) === state.connectionExpiresAt
}

/** No connection or credential is read until a method is invoked. */
export function createStore({ pool, connection, withDatabaseClient, withOwnerConnectionLock, listRepositoriesForUser, now = Date.now }) {
  const owner = async (q, lock = false) => (await q.query('SELECT ' + COLUMNS + ' FROM github_connections WHERE "userId"=$1' + (lock ? ' FOR SHARE' : ''), [OWNER_USER_ID])).rows[0]
  async function identity() {
    const { rows } = await pool.query('SELECT id,email FROM "user" WHERE id=ANY($1::text[])', [[OWNER_USER_ID, SMOKE_USER_ID]])
    check(rows.length === 2
      && hash(rows.find(row => row.id === OWNER_USER_ID)?.email ?? '') === 'c6032681fcca35e9a45d042dc67def8773bf58b68cc42392d2ce643c79765a42'
      && hash(rows.find(row => row.id === SMOKE_USER_ID)?.email ?? '') === 'a20ddbf2c101381c3de802e5e546365caf46bc80b69f3526cd967331cf9bb20d', 'principal_mismatch')
  }
  async function idle(q = pool) {
    const { rows: [row] } = await q.query('SELECT '
      + '(SELECT count(*) FROM agent_runs WHERE "userId"=$1 AND status=ANY($2::text[])) AS runs,'
      + '(SELECT count(*) FROM factory_tasks WHERE "userId"=$1 AND status IN (\'pending\',\'running\',\'waiting\')) AS tasks,'
      + '(SELECT count(*) FROM bot_subagents WHERE "ownerId"=$1 AND status IN (\'queued\',\'running\',\'needs_you\')) AS subagents,'
      + '(SELECT count(*) FROM coordinator_sessions WHERE "userId"=$1 AND ("leaseUntil">now() OR ("leaseHolder" IS NOT NULL AND "leaseUntil" IS NULL))) AS coordinators,'
      + '(SELECT count(*) FROM run_publications WHERE "userId"=$1 AND (status IN (\'pending\',\'processing\') OR "leaseExpiresAt">now())) AS publications,'
      + '(SELECT count(*) FROM factory_merges WHERE "userId"=$1 AND status=\'merging\') AS merges,'
      + '(SELECT count(*) FROM thread_machines WHERE "ownerId"=$1 AND (state=\'running\' OR "workerLeaseUntil">now() OR ("workerLeaseId" IS NOT NULL AND "workerLeaseUntil" IS NULL))) AS threads,'
      + '(SELECT count(*) FROM cloud_machines WHERE "ownerId"=$1 AND (state IN (\'running\',\'waking\') OR "workerLeaseUntil">now() OR "provisionLeaseUntil">now() OR ("workerLeaseId" IS NOT NULL AND "workerLeaseUntil" IS NULL) OR ("provisionLeaseId" IS NOT NULL AND "provisionLeaseUntil" IS NULL))) AS machines',
    [SMOKE_USER_ID, active])
    check(row && Object.keys(row).length === 8 && Object.values(row).every(value => Number.isSafeInteger(Number(value)) && Number(value) === 0), 'smoke_work_active')
  }
  async function assertVacant(q = pool) {
    check((await q.query('SELECT 1 FROM github_connections WHERE "userId"=$1', [SMOKE_USER_ID])).rows.length === 0, 'smoke_connection_exists')
    check((await q.query('SELECT 1 FROM account WHERE "userId"=$1 AND "providerId"=$2', [SMOKE_USER_ID, 'github'])).rows.length === 0, 'smoke_legacy_github_exists')
  }
  async function matching(q, state, lock = false) {
    validateState(state)
    const row = (await q.query('SELECT ' + COLUMNS + ' FROM github_connections WHERE "userId"=$1' + (lock ? ' FOR UPDATE' : ''), [SMOKE_USER_ID])).rows[0]
    if (!row) return null
    check(matches(row, state), 'smoke_connection_changed')
    const token = await connection.unsealGitHubSecret(row.accessToken)
    check(hash(token) === state.tokenSha256, 'smoke_connection_changed')
    return token
  }
  async function transaction(work) {
    const client = await pool.connect(); let failed = false
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      await client.query("SET LOCAL lock_timeout='5s'")
      await client.query("SET LOCAL statement_timeout='30s'")
      return await work(client)
    } catch (error) {
      failed = true
      try { await client.query({ text: 'ROLLBACK', query_timeout: 10_000 }) } catch { /* Close this client, not the original error. */ }
      throw error
    } finally { client.release(failed) }
  }
  return {
    identity, idle, assertVacant,
    async prepareOwnerSource(beforeGetter = async () => {}) {
      return withOwnerConnectionLock(async row => {
        check(row?.userId === OWNER_USER_ID && row.githubAccountId === GITHUB_ACCOUNT_ID && row.githubLogin === GITHUB_LOGIN
          && row.accessTokenExpiresAt instanceof Date && Number.isFinite(row.accessTokenExpiresAt.getTime())
          && row.updatedAt instanceof Date && Number.isFinite(row.updatedAt.getTime()), 'owner_source_not_fresh')
        const before = { updatedAt: row.updatedAt.toISOString(), expiresAt: row.accessTokenExpiresAt.toISOString() }
        await beforeGetter()
        // The existing normal getter owns refresh and sealed persistence. Its
        // return token is discarded; minting starts only after outer COMMIT.
        await connection.githubConnectionToken(OWNER_USER_ID, { minValidityMs: 660000 })
        return before
      })
    },
    async ownerSourceNoRefresh() {
      const row = await owner(pool)
      check(row?.userId === OWNER_USER_ID && row.githubAccountId === GITHUB_ACCOUNT_ID && row.githubLogin === GITHUB_LOGIN
        && row.accessTokenExpiresAt instanceof Date && row.accessTokenExpiresAt.getTime() > now() + 600_000, 'owner_source_not_fresh')
      return { token: await connection.unsealGitHubSecret(row.accessToken), githubAccountId: row.githubAccountId, expiresAt: row.accessTokenExpiresAt.toISOString(),
        metadata: { updatedAt: iso(row.updatedAt), expiresAt: iso(row.accessTokenExpiresAt), hasRefreshToken: row.hasRefreshToken },
        sealedFingerprint: hash(row.accessToken) }
    },
    async assertOwnerUnchanged(source) { check(sameOwner(await owner(pool), source), 'owner_connection_changed') },
    install(source, prepared, beforeCommit) {
      return transaction(async client => {
        check(sameOwner(await owner(client, true), source), 'owner_connection_changed')
        await idle(client); await assertVacant(client)
        const expiresIn = lifetime(prepared.providerExpiry, now())
        await withDatabaseClient(client, () => connection.saveGitHubConnection(SMOKE_USER_ID,
          { githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN }, { access_token: prepared.token, expires_in: expiresIn }))
        const row = (await client.query('SELECT ' + COLUMNS + ' FROM github_connections WHERE "userId"=$1', [SMOKE_USER_ID])).rows[0]
        check(row && row.hasRefreshToken === false && row.refreshTokenExpiresAt === null && row.accessTokenExpiresAt instanceof Date
          && row.accessTokenExpiresAt.getTime() <= prepared.providerExpiry && row.accessTokenExpiresAt.getTime() > now() + 45 * 60_000
          && hash(await connection.unsealGitHubSecret(row.accessToken)) === prepared.tokenSha256, 'stored_credential_invalid')
        const state = stateFor(prepared, { expiresAt: iso(row.accessTokenExpiresAt), updatedAt: iso(row.updatedAt) })
        check(matches(row, state), 'stored_identity_invalid')
        await beforeCommit(state)
        await client.query({ text: 'COMMIT', query_timeout: 10_000 })
        return state
      })
    },
    listRepositories: appId => listRepositoriesForUser(SMOKE_USER_ID, appId),
    matchingToken: state => matching(pool, state),
    disconnectMatching(state) {
      return transaction(async client => {
        await idle(client)
        const token = await matching(client, state, true)
        if (token) await withDatabaseClient(client, () => connection.disconnectGitHub(SMOKE_USER_ID))
        await client.query({ text: 'COMMIT', query_timeout: 10_000 })
      })
    },
  }
}
