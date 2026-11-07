import { createHash } from 'node:crypto'
import { SMOKE_USER_ID, OWNER_USER_ID, GITHUB_ACCOUNT_ID, GITHUB_LOGIN } from '../issue1503-smoke-github.mjs'
import { renewalConnection } from './renew-github-expiry.mjs'

const WORKSPACE_ID = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const ACTIVE = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw new Error(`issue1503_github_rotation_${code}`) }
const check = (value, code) => { if (!value) fail(code) }
const iso = value => value instanceof Date ? value.toISOString() : value
const COLUMNS = `"userId","githubAccountId","githubLogin","accessToken",
  ("refreshToken" IS NOT NULL) AS "hasRefreshToken","accessTokenExpiresAt","refreshTokenExpiresAt","updatedAt"`
const ownerMetadata = row => ({ userId: row?.userId, githubAccountId: row?.githubAccountId, githubLogin: row?.githubLogin,
  updatedAt: iso(row?.updatedAt), expiresAt: iso(row?.accessTokenExpiresAt), hasRefreshToken: row?.hasRefreshToken === true })
const sameOwner = (row, source) => row && JSON.stringify(ownerMetadata(row)) === JSON.stringify(source.metadata)
  && hash(row.accessToken) === source.sealedFingerprint
const connectionShape = row => ({ ...row, refreshToken: row?.hasRefreshToken ? true : null })

/** Injectable adapter for the normal, sealed connection service. No DB client
 * is acquired or credential read until one of these methods is invoked. */
export function createRotationStore({ pool, workspacePool, withDatabaseClient, connection, now = Date.now, lifetime }) {
  const selectOwner = async (query, locked = false) => (await query.query(`SELECT ${COLUMNS} FROM github_connections
    WHERE "userId"=$1${locked ? ' FOR SHARE' : ''}`, [OWNER_USER_ID])).rows[0]
  async function matching(query, state, locked = false) {
    const { rows: [row] } = await query.query(`SELECT ${COLUMNS} FROM github_connections
      WHERE "userId"=$1 AND "updatedAt"=$2::timestamptz AND "accessTokenExpiresAt"=$3::timestamptz${locked ? ' FOR UPDATE' : ''}`,
    [SMOKE_USER_ID, state.connectionUpdatedAt, state.connectionExpiresAt])
    renewalConnection(connectionShape(row), state)
    const token = await connection.unsealGitHubSecret(row.accessToken)
    check(hash(token) === state.tokenSha256, 'old_child_changed')
    return { row, token }
  }
  async function idle(query = pool) {
    const { rows: [row] } = await query.query(`SELECT
      (SELECT count(*) FROM agent_runs WHERE "userId"=$1 AND status=ANY($2::text[])) AS "activeRuns",
      (SELECT count(*) FROM factory_tasks WHERE "userId"=$1 AND status IN ('pending','running','waiting')) AS "pendingFactoryTasks",
      (SELECT count(*) FROM bot_subagents WHERE "ownerId"=$1 AND status IN ('queued','running','needs_you')) AS "pendingSubagents",
      (SELECT count(*) FROM coordinator_sessions WHERE "userId"=$1 AND
        ("leaseUntil">now() OR ("leaseHolder" IS NOT NULL AND "leaseUntil" IS NULL))) AS "coordinatorLeases",
      (SELECT count(*) FROM run_publications WHERE "userId"=$1 AND
        (status IN ('pending','processing') OR "leaseExpiresAt">now())) AS "pendingPublications",
      (SELECT count(*) FROM factory_merges WHERE "userId"=$1 AND status='merging') AS "pendingMerges",
      (SELECT count(*) FROM thread_machines WHERE "ownerId"=$1 AND
        (state='running' OR "workerLeaseUntil">now() OR ("workerLeaseId" IS NOT NULL AND "workerLeaseUntil" IS NULL))) AS "activeThreadMachines",
      (SELECT count(*) FROM cloud_machines WHERE "ownerId"=$1 AND
        (state IN ('running','waking') OR "workerLeaseUntil">now() OR "provisionLeaseUntil">now()
          OR ("workerLeaseId" IS NOT NULL AND "workerLeaseUntil" IS NULL)
          OR ("provisionLeaseId" IS NOT NULL AND "provisionLeaseUntil" IS NULL))) AS "activeCloudMachines"`, [SMOKE_USER_ID, ACTIVE])
    const counts = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]))
    check(Object.keys(counts).length === 8 && Object.values(counts).every(value => Number.isSafeInteger(value) && value === 0), 'smoke_work_active')
    return counts
  }
  const stateFor = (before, prepared, row) => ({ ...before, ...prepared.metadata,
    tokenSha256: prepared.tokenSha256, connectionUpdatedAt: iso(row.updatedAt), connectionExpiresAt: iso(row.accessTokenExpiresAt) })
  async function newState(before, prepared, row) {
    check(row?.userId === SMOKE_USER_ID && row.githubAccountId === GITHUB_ACCOUNT_ID && row.githubLogin === GITHUB_LOGIN
      && row.hasRefreshToken === false && row.refreshTokenExpiresAt === null && row.updatedAt instanceof Date
      && row.accessTokenExpiresAt instanceof Date && row.accessTokenExpiresAt.getTime() <= prepared.providerExpiry
      && row.accessTokenExpiresAt.getTime() > now() && hash(await connection.unsealGitHubSecret(row.accessToken)) === prepared.tokenSha256,
    'new_connection_mismatch')
    return stateFor(before, prepared, row)
  }
  return {
    async validateFixture(fixture) {
      check(fixture.issue === 1503 && fixture.workspaceId === WORKSPACE_ID && fixture.smokeUserId === SMOKE_USER_ID
        && fixture.ownerUserId === OWNER_USER_ID, 'fixture_mismatch')
      const { rows: [row] } = await workspacePool.query(`SELECT w."userId",w.kind,w.slug,
        (SELECT count(*) FROM mikka_workspace_members m WHERE m."workspaceId"=w.id) AS members,
        (SELECT count(*) FROM mikka_workspace_members m WHERE m."workspaceId"=w.id AND m.status='active' AND m."userId"=ANY($2::text[])) AS active
        FROM mikka_workspaces w WHERE w.id=$1`, [WORKSPACE_ID, [SMOKE_USER_ID, OWNER_USER_ID]])
      check(row?.userId === SMOKE_USER_ID && row.kind === 'team' && row.slug === 'issue-1503-factory-smoke-20261106'
        && Number(row.members) === 2 && Number(row.active) === 2, 'fixture_membership_changed')
    },
    idle,
    async matching(state) { await matching(pool, state) },
    async ownerSourceNoRefresh() {
      const row = await selectOwner(pool)
      check(row?.userId === OWNER_USER_ID && row.githubAccountId === GITHUB_ACCOUNT_ID && row.githubLogin === GITHUB_LOGIN,
        'owner_connection_missing')
      // Deliberately does not call githubConnectionToken/githubTokenForUser,
      // whose minValidity option is allowed to refresh the original Owner.
      check(row.accessTokenExpiresAt instanceof Date && row.accessTokenExpiresAt.getTime() > now() + 600_000, 'owner_source_not_fresh')
      return { token: await connection.unsealGitHubSecret(row.accessToken), githubAccountId: row.githubAccountId,
        expiresAt: row.accessTokenExpiresAt.toISOString(), metadata: ownerMetadata(row), sealedFingerprint: hash(row.accessToken) }
    },
    async ownerMetadata() { return ownerMetadata(await selectOwner(pool)) },
    async replace(before, source, prepared, hooks) {
      const client = await pool.connect()
      let failed = false
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        await client.query("SET LOCAL lock_timeout='5s'")
        await client.query("SET LOCAL statement_timeout='30s'")
        check(sameOwner(await selectOwner(client, true), source), 'owner_connection_changed')
        const { token: oldToken } = await matching(client, before, true)
        const activity = await idle(client)
        lifetime(prepared.providerExpiry, now())
        await hooks.beforeRevoke(activity)
        // The old sealed row is still intact here, including on DELETE failure.
        // Only this idle fixture may briefly retain a now-revoked credential if
        // its following save fails. A future invocation can repeat this exact CAS.
        await hooks.revokeOld(oldToken)
        const duration = lifetime(prepared.providerExpiry, now())
        await withDatabaseClient(client, () => connection.saveGitHubConnection(SMOKE_USER_ID,
          { githubAccountId: GITHUB_ACCOUNT_ID, githubLogin: GITHUB_LOGIN }, { access_token: prepared.token, expires_in: duration.expiresIn }))
        const { rows: [saved] } = await client.query(`SELECT ${COLUMNS} FROM github_connections WHERE "userId"=$1`, [SMOKE_USER_ID])
        const after = await newState(before, prepared, saved)
        check(saved.accessTokenExpiresAt.getTime() <= prepared.providerExpiry && saved.accessTokenExpiresAt.getTime() >= now() + 7_190_000,
          'saved_validity_mismatch')
        await hooks.prepared(after)
        await client.query('COMMIT')
        return after
      } catch (error) {
        failed = true
        // Finish this transaction before a new lock-read can classify an
        // ambiguous COMMIT. A broken client is always removed from the pool.
        try { await client.query({ text: 'ROLLBACK', query_timeout: 10_000 }) } catch { /* release(true) closes it below. */ }
        throw error
      } finally { client.release(failed) }
    },
    async observe(before, prepared) {
      const client = await pool.connect()
      let failed = false
      try {
        await client.query('BEGIN')
        await client.query("SET LOCAL lock_timeout='10s'")
        await client.query("SET LOCAL statement_timeout='15s'")
        // FOR UPDATE waits for the earlier transaction's commit/abort. A plain
        // MVCC SELECT could see the old row while COMMIT was still in flight.
        const { rows: [row] } = await client.query(`SELECT ${COLUMNS} FROM github_connections WHERE "userId"=$1 FOR UPDATE`, [SMOKE_USER_ID])
        let result = { kind: 'changed' }
        if (row) {
          const fingerprint = hash(await connection.unsealGitHubSecret(row.accessToken))
          if (fingerprint === prepared.tokenSha256) result = { kind: 'new', state: await newState(before, prepared, row) }
          else if (fingerprint === before.tokenSha256) {
            renewalConnection(connectionShape(row), before)
            result = { kind: 'old' }
          }
        }
        await client.query('COMMIT')
        return result
      } catch (error) {
        failed = true
        try { await client.query({ text: 'ROLLBACK', query_timeout: 10_000 }) } catch { /* Destroy the uncertain client. */ }
        throw error
      } finally { client.release(failed) }
    },
  }
}
