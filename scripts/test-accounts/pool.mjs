import { createHash, randomUUID } from 'node:crypto'
import { assertDatabaseIdentity, validateEnvironment, EnvironmentError } from './environment.mjs'
import { retainedSessionUpdate, assertOneRetainedSessionUpdated } from './retained-session-plan.mjs'

const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/
const UUID = /^[a-f0-9-]{36}$/
const TABLES = Object.freeze({
  user: ['user', 'id'], session: ['session', 'id'], account: ['account', 'id'],
  bots: ['bots', 'id'], issues: ['issues', 'id'], issue_versions: ['issue_versions', 'id'],
  agents: ['agents', 'id'], agent_runs: ['agent_runs', 'id'], run_chunks: ['run_chunks', 'id'],
  run_messages: ['run_messages', 'id'], coordinator_messages: ['coordinator_messages', 'id'],
  conversation_reads: ['conversation_reads', 'conversationId'],
})
const quote = name => `"${name.replaceAll('"', '""')}"`
const digest = value => createHash('sha256').update(value).digest('hex')

export class TestAccountError extends Error {
  constructor(code) { super(code); this.name = 'TestAccountError'; this.code = code }
}
const fail = code => { throw new TestAccountError(code) }
function label(value) { if (typeof value !== 'string' || !LABEL.test(value)) fail('INVALID_REQUEST'); return value }
function duration(value = 90_000) {
  if (!Number.isSafeInteger(value) || value < 1000 || value > 300_000) fail('INVALID_REQUEST')
  return value
}

/** Test metadata only. Never imported by application auth or Agent run leases. */
export class TestAccountPool {
  constructor(database, environment) {
    this.database = database
    this.environment = validateEnvironment(environment)
  }

  async transaction(work, { readOnly = false } = {}) {
    // Read-only inspection remains available. No pool writes may run until
    // the shared environment and complete retention lifecycle are verified.
    const retainSafePoolWritesAvailable = false
    if (!readOnly && !retainSafePoolWritesAvailable) fail('ACCOUNT_POOL_RETENTION_BLOCKED')
    const client = await this.database.connect()
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN')
      await client.query("SET LOCAL statement_timeout = '10s'")
      await client.query("SET LOCAL lock_timeout = '5s'")
      await assertDatabaseIdentity(client, this.environment)
      // Small test pools favor a single transaction lock over a second lock service.
      // It is shared by all processes/machines using this exact registered PG target.
      if (!readOnly) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 349))', [this.environment.instanceId])
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      if (error instanceof TestAccountError || error instanceof EnvironmentError) throw error
      // Driver errors can include SQL parameters. Never propagate them into reports.
      fail('ACCOUNT_POOL_DATABASE_ERROR')
    } finally { client.release() }
  }

  async prepare({ pairs = 2 } = {}) {
    if (!Number.isInteger(pairs) || pairs < 1 || pairs > 32) fail('INVALID_REQUEST')
    await this.transaction(async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS mikka_test_accounts.pairs (
        id text PRIMARY KEY, environment_id text NOT NULL, generation bigint NOT NULL DEFAULT 0,
        state text NOT NULL CHECK(state IN ('available','leased','quarantined')),
        active_lease_id uuid, blocked_reason text
      )`)
      await client.query(`CREATE TABLE IF NOT EXISTS mikka_test_accounts.accounts (
        slot_id text PRIMARY KEY, pair_id text NOT NULL REFERENCES mikka_test_accounts.pairs(id),
        role text NOT NULL CHECK(role IN ('owner','peer')), user_id text UNIQUE, email text UNIQUE,
        credential_ref text, baseline text, provision_lease_id uuid,
        UNIQUE(pair_id,role)
      )`)
      await client.query(`CREATE TABLE IF NOT EXISTS mikka_test_accounts.leases (
        id uuid PRIMARY KEY, environment_id text NOT NULL, request_id text NOT NULL,
        run_id text NOT NULL, worker_id text NOT NULL, pair_id text NOT NULL REFERENCES mikka_test_accounts.pairs(id),
        generation bigint NOT NULL, expires_at timestamptz NOT NULL, ttl_ms integer NOT NULL, executor_id uuid,
        state text NOT NULL CHECK(state IN ('active','released','quarantined')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(), released_at timestamptz,
        UNIQUE(environment_id,request_id)
      )`)
      const hasExecutor = (await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='mikka_test_accounts' AND table_name='leases' AND column_name='executor_id'")).rowCount
      if (!hasExecutor) await client.query('ALTER TABLE mikka_test_accounts.leases ADD COLUMN executor_id uuid')
      await client.query(`CREATE TABLE IF NOT EXISTS mikka_test_accounts.resources (
        lease_id uuid NOT NULL REFERENCES mikka_test_accounts.leases(id), type text NOT NULL,
        id text NOT NULL, owner_id text NOT NULL,
        state text NOT NULL CHECK(state IN ('created','retained','cleaned')),
        PRIMARY KEY(lease_id,type,id)
      )`)
      for (let i = 0; i < pairs; i++) {
        const id = `pair-${String(i).padStart(3, '0')}`
        await client.query("INSERT INTO mikka_test_accounts.pairs(id,environment_id,state) VALUES($1,$2,'available') ON CONFLICT(id) DO NOTHING", [id, this.environment.id])
        for (const role of ['owner', 'peer']) await client.query('INSERT INTO mikka_test_accounts.accounts(slot_id,pair_id,role) VALUES($1,$2,$3) ON CONFLICT(slot_id) DO NOTHING', [`${id}:${role}`, id, role])
      }
    })
    return this.inspect()
  }

  async snapshot(client, row) {
    const accounts = await client.query('SELECT slot_id, role, user_id, email, credential_ref FROM mikka_test_accounts.accounts WHERE pair_id=$1 ORDER BY role', [row.pair_id])
    const remaining = (await client.query('SELECT (extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::bigint AS remaining_ms', [row.expires_at])).rows[0].remaining_ms
    return {
      id: row.id, environmentId: row.environment_id, requestId: row.request_id,
      runId: row.run_id, workerId: row.worker_id, pairId: row.pair_id,
      generation: Number(row.generation), expiresAt: new Date(row.expires_at).toISOString(),
      ttlMs: row.ttl_ms, remainingMs: Math.max(0, Number(remaining)), state: row.state,
      accounts: accounts.rows.map(account => ({ slotId: account.slot_id, role: account.role,
        userId: account.user_id, email: account.email, credentialRef: account.credential_ref,
        namespace: `test-${digest(`${this.environment.instanceId}:${row.id}:${row.generation}:${account.role}`).slice(0, 24)}`,
      })),
    }
  }

  async current(client, lease, { terminal = false, readOnly = false, requireUnexpired = false } = {}) {
    if (!lease || !UUID.test(lease.id ?? '') || !Number.isSafeInteger(lease.generation) || lease.environmentId !== this.environment.id) fail('STALE_LEASE')
    // The clock projection of SELECT ... FOR UPDATE may be evaluated before a
    // blocked row lock is granted. Lock first, then read a fresh DB clock/row.
    if (!readOnly) await client.query('SELECT id FROM mikka_test_accounts.leases WHERE id=$1 FOR UPDATE', [lease.id])
    const row = (await client.query(`SELECT l.*, p.generation AS current_generation, p.active_lease_id,
      (extract(epoch FROM (l.expires_at-clock_timestamp()))*1000)::bigint AS remaining_ms
      FROM mikka_test_accounts.leases l JOIN mikka_test_accounts.pairs p ON p.id=l.pair_id WHERE l.id=$1`, [lease.id])).rows[0]
    if (!row || row.environment_id !== this.environment.id || row.pair_id !== lease.pairId || row.run_id !== lease.runId || row.worker_id !== lease.workerId || Number(row.generation) !== lease.generation || Number(row.current_generation) !== lease.generation) fail('STALE_LEASE')
    if (terminal && row.state !== 'active' && row.released_at) {
      if (requireUnexpired && Number(row.remaining_ms) <= 0) fail('LEASE_LOST')
      return row
    }
    if (row.state !== 'active' || row.active_lease_id !== row.id || Number(row.remaining_ms) <= 0) fail('LEASE_LOST')
    return row
  }

  async expire(client) {
    // Expiry is loss of authority, never proof that the old runner stopped.
    await client.query(`UPDATE mikka_test_accounts.pairs p SET state='quarantined',blocked_reason='LEASE_EXPIRED_UNPROVEN_STOP'
      FROM mikka_test_accounts.leases l WHERE p.active_lease_id=l.id AND l.state='active' AND l.expires_at<=clock_timestamp()`)
    await client.query("UPDATE mikka_test_accounts.leases SET state='quarantined' WHERE state='active' AND expires_at<=clock_timestamp()")
  }

  async acquire({ runId, workerId, requestId, ttlMs = 90_000 }) {
    label(runId); label(workerId); label(requestId); duration(ttlMs)
    const result = await this.transaction(async client => {
      await this.expire(client)
      const old = (await client.query('SELECT *, (extract(epoch FROM (expires_at-clock_timestamp()))*1000)::bigint AS remaining_ms FROM mikka_test_accounts.leases WHERE environment_id=$1 AND request_id=$2', [this.environment.id, requestId])).rows[0]
      if (old) {
        if (old.run_id !== runId || old.worker_id !== workerId) fail('REQUEST_CONFLICT')
        return this.snapshot(client, old)
      }
      const candidates = (await client.query("SELECT * FROM mikka_test_accounts.pairs WHERE environment_id=$1 AND state='available' ORDER BY id", [this.environment.id])).rows
      for (const pair of candidates) {
        const reason = await this.cleanReason(client, pair.id)
        if (reason) { await client.query("UPDATE mikka_test_accounts.pairs SET state='quarantined',blocked_reason=$2 WHERE id=$1", [pair.id, reason]); continue }
        const id = randomUUID()
        const generation = Number(pair.generation) + 1
        const row = (await client.query(`INSERT INTO mikka_test_accounts.leases(id,environment_id,request_id,run_id,worker_id,pair_id,generation,expires_at,ttl_ms,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8*interval '1 millisecond',$8,'active') RETURNING *`, [id, this.environment.id, requestId, runId, workerId, pair.id, generation, ttlMs])).rows[0]
        await client.query("UPDATE mikka_test_accounts.pairs SET state='leased',generation=$2,active_lease_id=$3,blocked_reason=NULL WHERE id=$1", [pair.id, generation, id])
        return this.snapshot(client, row)
      }
      // Commit quarantine changes even when every candidate is unavailable.
      return { blocked: 'POOL_EXHAUSTED' }
    })
    if (result.blocked) fail(result.blocked)
    return result
  }

  /** A retry can recover its lease ID, but cannot start a second live consumer. */
  async attachSession(lease, executorId) {
    if (!UUID.test(executorId ?? '')) fail('INVALID_REQUEST')
    return this.transaction(async client => {
      await this.current(client, lease)
      const attached = await client.query(`UPDATE mikka_test_accounts.leases SET executor_id=$2
        WHERE id=$1 AND state='active' AND expires_at>clock_timestamp()
        AND (executor_id IS NULL OR executor_id=$2) RETURNING id`, [lease.id, executorId])
      if (!attached.rowCount) {
        await this.current(client, lease)
        fail('LEASE_ALREADY_ATTACHED')
      }
      await this.current(client, lease)
      return { leaseId: lease.id, generation: lease.generation }
    })
  }

  async assertLease(lease) {
    return this.transaction(async client => this.snapshot(client, await this.current(client, lease, { readOnly: true })), { readOnly: true })
  }

  async renew(lease, { ttlMs = lease?.ttlMs ?? 90_000 } = {}) {
    duration(ttlMs)
    return this.transaction(async client => {
      await this.current(client, lease)
      const row = (await client.query("UPDATE mikka_test_accounts.leases SET expires_at=clock_timestamp()+$2*interval '1 millisecond',ttl_ms=$2 WHERE id=$1 AND state='active' AND expires_at>clock_timestamp() RETURNING *", [lease.id, ttlMs])).rows[0]
      if (!row) fail('LEASE_LOST')
      const result = await this.snapshot(client, row)
      await this.current(client, lease)
      return result
    })
  }

  async bindAccount(lease, { slotId, userId, email, credentialRef }) {
    label(slotId); label(userId)
    if (typeof email !== 'string' || !/^test-[a-f0-9-]+@(example\.test)$/.test(email) || typeof credentialRef !== 'string' || !/^[a-f0-9-]{36}\.json$/.test(credentialRef)) fail('INVALID_REQUEST')
    return this.transaction(async client => {
      await this.current(client, lease)
      const account = (await client.query('SELECT * FROM mikka_test_accounts.accounts WHERE slot_id=$1 AND pair_id=$2', [slotId, lease.pairId])).rows[0]
      if (!account) fail('STALE_LEASE')
      if (account.provision_lease_id !== lease.id || account.email !== email || account.credential_ref !== credentialRef) fail('ACCOUNT_RESERVATION_MISMATCH')
      if ((account.user_id && account.user_id !== userId) || (account.email && account.email !== email) || (account.credential_ref && account.credential_ref !== credentialRef)) fail('ACCOUNT_IDENTITY_MISMATCH')
      const user = (await client.query('SELECT id,email FROM public."user" WHERE id=$1', [userId])).rows[0]
      if (!user || user.email !== email) fail('ACCOUNT_IDENTITY_MISMATCH')
      if (!(await client.query('SELECT 1 FROM public.account WHERE "userId"=$1 AND "providerId"=$2', [userId, 'credential'])).rowCount) fail('ACCOUNT_IDENTITY_UNVERIFIED')
      await client.query('UPDATE mikka_test_accounts.accounts SET user_id=$2,email=$3,credential_ref=$4,provision_lease_id=coalesce(provision_lease_id,$5) WHERE slot_id=$1', [slotId, userId, email, credentialRef, lease.id])
      await client.query("INSERT INTO mikka_test_accounts.resources(lease_id,type,id,owner_id,state) VALUES($1,'user',$2,$2,'retained') ON CONFLICT DO NOTHING", [lease.id, userId])
      const result = await this.snapshot(client, await this.current(client, lease))
      await this.current(client, lease)
      return result
    })
  }

  async reserveAccount(lease, { slotId, email, credentialRef }) {
    if (typeof email !== 'string' || !/^test-[a-f0-9-]+@example\.test$/.test(email) || !/^[a-f0-9-]{36}\.json$/.test(credentialRef ?? '')) fail('INVALID_REQUEST')
    return this.transaction(async client => {
      await this.current(client, lease)
      const row = (await client.query('SELECT * FROM mikka_test_accounts.accounts WHERE slot_id=$1 AND pair_id=$2', [slotId, lease.pairId])).rows[0]
      if (!row || row.user_id || row.email || row.credential_ref) fail('ACCOUNT_ALREADY_RESERVED')
      if ((await client.query('SELECT 1 FROM public."user" WHERE email=$1', [email])).rowCount) fail('ACCOUNT_ALREADY_EXISTS')
      await client.query('UPDATE mikka_test_accounts.accounts SET email=$2,credential_ref=$3,provision_lease_id=$4 WHERE slot_id=$1', [slotId, email, credentialRef, lease.id])
      await this.current(client, lease)
    })
  }

  /** One baseline only, taken by the provisioner after normal app initialization. */
  async sealAccount(lease, slotId) {
    return this.transaction(async client => {
      await this.current(client, lease)
      const row = (await client.query('SELECT * FROM mikka_test_accounts.accounts WHERE slot_id=$1 AND pair_id=$2', [slotId, lease.pairId])).rows[0]
      if (!row?.user_id || row.provision_lease_id !== lease.id || row.baseline) fail('ACCOUNT_BASELINE_FORBIDDEN')
      const baseline = await this.fingerprint(client, row.user_id)
      await client.query('UPDATE mikka_test_accounts.accounts SET baseline=$2 WHERE slot_id=$1', [slotId, baseline])
      await this.current(client, lease)
    })
  }

  async ownedRows(client, userId) {
    // Follow parent -> child ownership only. Membership in somebody else's
    // workspace does not pull that workspace or its other people's data in.
    // Real FKs are authoritative; setup-e2e-db creates some legacy tables without
    // FKs, so these reviewed logical links cover the same current schema.
    const inferred = {
      runId: 'agent_runs', issueId: 'issues', agentId: 'agents', botId: 'bots',
      workspaceId: 'mikka_workspaces', teamId: 'mikka_teams', projectId: 'workspace_projects',
      artifactId: 'artifacts', conversationId: 'conversations', sourceConversationId: 'conversations',
      linkedConversationId: 'conversations', deviceId: 'devices', boundDeviceId: 'devices',
      deviceRepoId: 'device_repos', teamSyncId: 'linear_team_syncs', issueLinkId: 'linear_issue_links',
      suggestionId: 'suggestions', matterId: 'attention_matters', computerId: 'cloud_computers',
    }
    const ownerColumns = new Set(['userId', 'ownerId', 'memberId', 'createdBy', 'invitedBy', 'authorId', 'authorUserId', 'user_id', 'owner_id', 'created_by'])
    const catalog = (await client.query(`SELECT c.table_name, array_agg(c.column_name::text ORDER BY c.column_name) AS columns
      FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
      WHERE c.table_schema='public' AND t.table_type='BASE TABLE' AND c.table_name NOT IN ('session','verification')
      GROUP BY c.table_name ORDER BY c.table_name`)).rows
    const tables = new Map(catalog.map(table => [table.table_name, new Set(table.columns)]))
    const edges = (await client.query(`SELECT child.relname AS child, parent.relname AS parent,
      array_agg(ca.attname::text ORDER BY key.ordinality) AS child_columns,
      array_agg(pa.attname::text ORDER BY key.ordinality) AS parent_columns
      FROM pg_constraint fk JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_namespace cn ON cn.oid=child.relnamespace
      JOIN pg_class parent ON parent.oid=fk.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace
      JOIN LATERAL unnest(fk.conkey,fk.confkey) WITH ORDINALITY AS key(child_number,parent_number,ordinality) ON true
      JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=key.child_number
      JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=key.parent_number
      WHERE fk.contype='f' AND cn.nspname='public' AND pn.nspname='public'
      GROUP BY fk.oid, child.relname, parent.relname ORDER BY child.relname,parent.relname,fk.oid`)).rows
      .filter(edge => tables.has(edge.child) && tables.has(edge.parent))
    for (const [child, columns] of tables) {
      for (const [column, parent] of Object.entries(inferred)) {
        if (columns.has(column) && tables.get(parent)?.has('id')) edges.push({ child, parent, child_columns: [column], parent_columns: ['id'] })
      }
    }
    for (const [child, column, parent] of [['agent_turns', 'sessionId', 'agent_sessions'], ['native_coordinator_tools', 'turnId', 'native_coordinator_turns']]) {
      if (tables.get(child)?.has(column) && tables.get(parent)?.has('id')) edges.push({ child, parent, child_columns: [column], parent_columns: ['id'] })
    }
    const byChild = new Map()
    for (const edge of new Map(edges.map(edge => [JSON.stringify(edge), edge])).values()) {
      if (!byChild.has(edge.child)) byChild.set(edge.child, [])
      byChild.get(edge.child).push(edge)
    }
    const owned = new Map(), queried = new Map()
    for (let round = 0; round < 32; round++) {
      let changed = false
      for (const [table, columns] of tables) {
        const args = [userId]
        const conditions = [...columns].filter(column => ownerColumns.has(column)).map(column => `t.${quote(column)}::text=$1`)
        if (table === 'user') conditions.push('t.id=$1')
        for (const edge of byChild.get(table) ?? []) {
          const values = [...new Set((owned.get(edge.parent) ?? []).map(row => edge.parent_columns.map(column => row.value[column]))
            .filter(tuple => tuple.every(value => value !== undefined && value !== null)).map(tuple => JSON.stringify(tuple.map(String))))].map(value => JSON.parse(value))
          if (!values.length) continue
          args.push(JSON.stringify(values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))))
          conditions.push(`EXISTS (SELECT 1 FROM jsonb_array_elements($${args.length}::jsonb) AS wanted(value) WHERE ${edge.child_columns.map((column, index) => `t.${quote(column)}::text=wanted.value->>${index}`).join(' AND ')})`)
        }
        if (!conditions.length) continue
        const signature = JSON.stringify([conditions, args])
        if (queried.get(table) === signature) continue
        queried.set(table, signature)
        const rows = (await client.query(`SELECT to_jsonb(t)::text AS data FROM public.${quote(table)} t WHERE $1::text IS NOT NULL AND (${conditions.join(' OR ')}) LIMIT 10001`, args)).rows
        if (rows.length > 10000) fail('ACCOUNT_FOOTPRINT_UNPROVEN')
        const ordered = rows.map(row => ({ text: row.data, value: JSON.parse(row.data) })).sort((a, b) => a.text.localeCompare(b.text))
        if (JSON.stringify(ordered.map(row => row.text)) !== JSON.stringify((owned.get(table) ?? []).map(row => row.text))) changed = true
        owned.set(table, ordered)
      }
      if (!changed) return owned
    }
    fail('ACCOUNT_FOOTPRINT_UNPROVEN')
  }

  async fingerprint(client, userId) {
    const hash = createHash('sha256')
    const owned = await this.ownedRows(client, userId)
    for (const [table, rows] of [...owned].sort(([a], [b]) => a.localeCompare(b))) hash.update(JSON.stringify([table, rows.map(row => row.text)]))
    return hash.digest('hex')
  }

  async cleanReason(client, pairId) {
    const accounts = (await client.query('SELECT * FROM mikka_test_accounts.accounts WHERE pair_id=$1 ORDER BY role', [pairId])).rows
    if (accounts.length !== 2) return 'ACCOUNT_SLOTS_INVALID'
    const bound = accounts.filter(account => account.user_id)
    if (accounts.some(account => !account.user_id && (account.email || account.credential_ref))) return 'PARTIAL_PROVISIONING'
    if (bound.length !== 0 && bound.length !== 2) return 'PARTIAL_PROVISIONING'
    for (const account of bound) {
      const user = (await client.query('SELECT email FROM public."user" WHERE id=$1', [account.user_id])).rows[0]
      if (!user || user.email !== account.email || !account.credential_ref || !account.baseline) return 'ACCOUNT_IDENTITY_UNVERIFIED'
      // Expiry alone is not retention proof: Better Auth deletes an expired row
      // when its old token is presented. Only this transaction's tracked rotation
      // can establish that the old token no longer resolves to the retained row.
      if ((await client.query(`SELECT 1 FROM public.session s WHERE s."userId"=$1
        AND (s."expiresAt">clock_timestamp() OR NOT EXISTS (
          SELECT 1 FROM mikka_test_accounts.resources r WHERE r.type='session'
          AND r.id=s.id AND r.owner_id=s."userId" AND r.state='retained'
        )) LIMIT 1`, [account.user_id])).rowCount) return 'ACCOUNT_SESSION_STILL_ACTIVE'
      if (await this.fingerprint(client, account.user_id) !== account.baseline) return 'ACCOUNT_DIRTY'
    }
    return null
  }

  async recordResource(lease, { type, id, ownerId }) {
    if (!Object.hasOwn(TABLES, type)) fail('RESOURCE_TYPE_FORBIDDEN')
    label(id); label(ownerId)
    return this.transaction(async client => {
      await this.current(client, lease)
      const accounts = (await client.query('SELECT 1 FROM mikka_test_accounts.accounts WHERE pair_id=$1 AND user_id=$2', [lease.pairId, ownerId])).rowCount
      if (!accounts) fail('RESOURCE_OWNER_MISMATCH')
      const existing = (await client.query('SELECT * FROM mikka_test_accounts.resources WHERE type=$1 AND id=$2', [type, id])).rows
      if (existing.some(resource => resource.lease_id !== lease.id || resource.owner_id !== ownerId)) fail('RESOURCE_NOT_OWNED')
      if (existing.length) { await this.current(client, lease); return }
      const [table, column] = TABLES[type]
      const rows = (await client.query(`SELECT to_jsonb(t) AS value FROM public.${quote(table)} t WHERE ${quote(column)}::text=$1`, [id])).rows
      if (type === 'session') {
        if (rows.length !== 1 || rows[0].value.userId !== ownerId) fail('RESOURCE_OWNER_MISMATCH')
      } else if (rows.length) fail('RESOURCE_ALREADY_EXISTS')
      // Non-session fixtures reserve a previously absent ID BEFORE creation.
      // Existing data cannot be re-labelled as this run's cleanup entitlement.
      await client.query("INSERT INTO mikka_test_accounts.resources(lease_id,type,id,owner_id,state) VALUES($1,$2,$3,$4,'created')", [lease.id, type, id, ownerId])
      await this.current(client, lease)
    })
  }

  async markResourceCleaned(lease, { type, id }) {
    if (!Object.hasOwn(TABLES, type)) fail('RESOURCE_TYPE_FORBIDDEN')
    return this.transaction(async client => {
      await this.current(client, lease)
      const resource = (await client.query('SELECT * FROM mikka_test_accounts.resources WHERE lease_id=$1 AND type=$2 AND id=$3', [lease.id, type, id])).rows[0]
      if (!resource || resource.state === 'retained') fail('RESOURCE_NOT_OWNED')
      const [table, column] = TABLES[type]
      const owner = type === 'conversation_reads' ? ' AND "userId"=$2' : ''
      const args = type === 'conversation_reads' ? [id, resource.owner_id] : [id]
      if ((await client.query(`SELECT 1 FROM public.${quote(table)} WHERE ${quote(column)}::text=$1${owner} LIMIT 1`, args)).rowCount) fail('RESOURCE_STILL_PRESENT')
      await client.query("UPDATE mikka_test_accounts.resources SET state='cleaned' WHERE lease_id=$1 AND type=$2 AND id=$3", [lease.id, type, id])
      await this.current(client, lease)
    })
  }

  /** Retain tracked session rows while invalidating their issued tokens. */
  async revokeSessions(lease) {
    // Keep every caller blocked until the complete retained lifecycle is verified.
    const retainedSessionRevocationAvailable = false
    if (!retainedSessionRevocationAvailable) fail('TEST_ACCOUNT_SESSION_RETENTION_BLOCKED')
    if (!this.environment.capabilities.reset) fail('SESSION_REVOCATION_NOT_AUTHORIZED')
    return this.transaction(async client => {
      await this.current(client, lease)
      const sessions = (await client.query(`SELECT r.id, r.owner_id
        FROM mikka_test_accounts.resources r
        WHERE r.lease_id=$1 AND r.type='session' AND r.state='created'
        ORDER BY r.id FOR UPDATE`, [lease.id])).rows
      let revoked = 0
      for (const session of sessions) {
        // Better Auth may already have removed this exact tracked row during
        // sign-out. Record observed absence without recreating it or claiming
        // that it was retained. A row owned by someone else is never adopted.
        const existing = (await client.query('SELECT "userId" FROM public.session WHERE id=$1 FOR UPDATE', [session.id])).rows
        if (existing.length === 0) {
          const marked = await client.query("UPDATE mikka_test_accounts.resources SET state='cleaned' WHERE lease_id=$1 AND type='session' AND id=$2 AND owner_id=$3 AND state='created'", [lease.id, session.id, session.owner_id])
          if (marked.rowCount !== 1) fail('RESOURCE_NOT_OWNED')
          continue
        }
        if (existing.length !== 1 || existing[0].userId !== session.owner_id) fail('RESOURCE_OWNER_MISMATCH')
        const plan = retainedSessionUpdate({ sessionId: session.id, ownerId: session.owner_id, leaseId: lease.id, generation: lease.generation })
        const result = await client.query(plan.text, plan.values)
        assertOneRetainedSessionUpdated(result)
        revoked += result.rowCount
        const marked = await client.query("UPDATE mikka_test_accounts.resources SET state='retained' WHERE lease_id=$1 AND type='session' AND id=$2 AND owner_id=$3 AND state='created'", [lease.id, session.id, session.owner_id])
        if (marked.rowCount !== 1) fail('RESOURCE_NOT_OWNED')
      }
      await this.current(client, lease)
      return { revoked }
    })
  }

  async release(lease, { outcome = 'clean' } = {}) {
    if (!['clean', 'dirty', 'cancelled'].includes(outcome)) fail('INVALID_REQUEST')
    return this.transaction(async client => {
      const row = await this.current(client, lease, { terminal: true })
      if (row.state !== 'active') return this.snapshot(client, row)
      const pending = (await client.query("SELECT 1 FROM mikka_test_accounts.resources WHERE lease_id=$1 AND state='created' LIMIT 1", [lease.id])).rowCount
      const reason = outcome !== 'clean' ? `RUN_${outcome.toUpperCase()}` : pending ? 'RESOURCES_NOT_CLEANED' : await this.cleanReason(client, row.pair_id)
      const state = reason ? 'quarantined' : 'released'
      await this.current(client, lease)
      const updated = await client.query("UPDATE mikka_test_accounts.leases SET state=$2,released_at=clock_timestamp() WHERE id=$1 AND state='active' AND expires_at>clock_timestamp() RETURNING id", [row.id, state])
      if (!updated.rowCount) fail('LEASE_LOST')
      await client.query('UPDATE mikka_test_accounts.pairs SET state=$2,active_lease_id=$3,blocked_reason=$4 WHERE id=$1', [row.pair_id, reason ? 'quarantined' : 'available', reason ? row.id : null, reason])
      const result = await this.snapshot(client, { ...row, state })
      await this.current(client, lease, { terminal: true, requireUnexpired: true })
      return result
    })
  }

  async inspect() {
    return this.transaction(async client => {
      if (!(await client.query("SELECT to_regclass('mikka_test_accounts.pairs') AS table_name")).rows[0].table_name) return { environmentId: this.environment.id, prepared: false, pairs: [], leases: [] }
      const pairs = (await client.query(`SELECT p.id,p.generation,p.state,p.blocked_reason AS "blockedReason",
        CASE WHEN l.state='active' AND l.expires_at<=clock_timestamp() THEN true ELSE false END AS expired
        FROM mikka_test_accounts.pairs p LEFT JOIN mikka_test_accounts.leases l ON l.id=p.active_lease_id ORDER BY p.id`)).rows
      const leases = (await client.query('SELECT id,run_id AS "runId",worker_id AS "workerId",pair_id AS "pairId",generation,state,expires_at AS "expiresAt" FROM mikka_test_accounts.leases ORDER BY created_at')).rows
      return { environmentId: this.environment.id, prepared: true, pairs, leases }
    }, { readOnly: true })
  }

  async cleanupPlan({ runId }) {
    label(runId)
    return this.transaction(async client => {
      const resources = (await client.query(`SELECT r.type,r.id,r.owner_id AS "ownerId",r.state,l.id AS "leaseId",l.run_id AS "runId",l.state AS "leaseState",
        CASE WHEN l.state='active' OR p.state='leased' THEN 'ACTIVE_LEASE_PROTECTED'
          WHEN p.state='quarantined' THEN 'QUARANTINED_ACCOUNT_PROTECTED'
          WHEN r.state='retained' THEN 'REUSABLE_ACCOUNT_RETAINED'
          WHEN r.state='cleaned' THEN 'ALREADY_CLEANED' ELSE 'EXPLICIT_CLEANUP_APPROVAL_REQUIRED' END AS reason
        FROM mikka_test_accounts.resources r JOIN mikka_test_accounts.leases l ON l.id=r.lease_id
        LEFT JOIN mikka_test_accounts.accounts a ON a.user_id=r.owner_id
        LEFT JOIN mikka_test_accounts.pairs p ON p.id=a.pair_id
        WHERE l.run_id=$1 AND l.environment_id=$2 ORDER BY r.type,r.id`, [runId, this.environment.id])).rows
      const ownedByUser = new Map()
      for (const resource of resources) {
        const [table, column] = TABLES[resource.type]
        if (!ownedByUser.has(resource.ownerId)) ownedByUser.set(resource.ownerId, await this.ownedRows(client, resource.ownerId))
        const rows = resource.type === 'session'
          ? (await client.query('SELECT to_jsonb(s) AS value FROM public.session s WHERE id=$1 AND "userId"=$2', [resource.id, resource.ownerId])).rows
          : (ownedByUser.get(resource.ownerId).get(table) ?? [])
        resource.ownershipProven = rows.some(row => String(row.value[column]) === resource.id && (resource.type !== 'conversation_reads' || row.value.userId === resource.ownerId))
        if (resource.reason === 'EXPLICIT_CLEANUP_APPROVAL_REQUIRED' && !resource.ownershipProven) resource.reason = 'RESOURCE_OWNERSHIP_UNPROVEN'
      }
      const pendingProvisioning = (await client.query(`SELECT a.slot_id AS "slotId",l.id AS "leaseId",l.state AS "leaseState",a.email,
        CASE WHEN p.state='leased' THEN 'ACTIVE_LEASE_PROTECTED' ELSE 'INCOMPLETE_PROVISIONING_QUARANTINED' END AS reason
        FROM mikka_test_accounts.accounts a JOIN mikka_test_accounts.leases l ON l.id=a.provision_lease_id
        JOIN mikka_test_accounts.pairs p ON p.id=a.pair_id
        WHERE l.run_id=$1 AND l.environment_id=$2 AND a.user_id IS NULL AND a.email IS NOT NULL ORDER BY a.slot_id`, [runId, this.environment.id])).rows
      for (const pending of pendingProvisioning) {
        pending.identityHash = digest(pending.email)
        pending.userId = (await client.query('SELECT id FROM public."user" WHERE email=$1', [pending.email])).rows[0]?.id ?? null
        delete pending.email
      }
      return { environmentId: this.environment.id, runId, dryRun: true, deletesExecuted: 0, resources, pendingProvisioning }
    }, { readOnly: true })
  }
}
