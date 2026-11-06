import { createHash } from 'node:crypto'

const TABLES = new Set(['user', 'account', 'user_onboarding', 'mikka_workspaces', 'mikka_workspace_members', 'mikka_workspace_invitations', 'mikka_teams', 'mikka_team_members', 'mikka_team_issues', 'bots', 'issues', 'issue_versions', 'agents', 'agent_runs', 'run_chunks', 'run_messages', 'coordinator_bots', 'coordinator_sessions', 'coordinator_messages', 'conversations', 'conversation_members', 'conversation_messages', 'conversation_reads', 'issue_documents', 'workspace_audit_events', 'workspace_audit_outbox', 'devices', 'device_tokens', 'device_enrollments', 'artifacts', 'artifact_versions', 'artifact_shares', 'attention_settings', 'user_time_zones', 'briefings', 'coordinator_events'])
const FIELDS = new Set(['id', 'userId', 'ownerId', 'workspaceId', 'botId', 'agentId', 'conversationId', 'issueId', 'name', 'email', 'emailVerified', 'image', 'password', 'createdAt', 'updatedAt', 'lastReadAt', 'lastSeenAt', 'readAt', 'read_at', 'status', 'state', 'value', 'settings', 'preferences', 'data', 'cursor', 'unreadCount', 'expiresAt'])
const REASONS = new Set(['RUN_DIRTY', 'RUN_CANCELLED', 'RESOURCES_NOT_CLEANED', 'ACCOUNT_SLOTS_INVALID', 'PARTIAL_PROVISIONING', 'ACCOUNT_IDENTITY_UNVERIFIED', 'ACCOUNT_SESSION_STILL_ACTIVE', 'ACCOUNT_DIRTY', 'LEASE_EXPIRED_UNPROVEN_STOP'])
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invariant = condition => { if (!condition) throw new Error('ACCOUNT_DIAGNOSTIC_BINDING_FAILED') }

/** Hashes and raw field values stay in this observer's private memory.
 * Output is a closed vocabulary plus row/field counts, never identifiers. */
function summarizeOwned(owned) {
  const fingerprint = createHash('sha256')
  const tables = new Map()
  for (const [table, rows] of [...owned].sort(([a], [b]) => a.localeCompare(b))) {
    invariant(Array.isArray(rows) && rows.length <= 10000)
    fingerprint.update(JSON.stringify([table, rows.map(row => row.text)]))
    const fields = new Map()
    const keys = new Set(rows.flatMap(row => Object.keys(row.value)))
    for (const key of keys) {
      const values = rows.map(row => Object.hasOwn(row.value, key) ? ['present', row.value[key]] : ['absent'])
        .map(value => JSON.stringify(value)).sort()
      fields.set(key, hash(values))
    }
    tables.set(table, { count: rows.length, hash: hash(rows.map(row => row.text)), fields })
  }
  return { fingerprint: fingerprint.digest('hex'), tables }
}

async function capture(scope, lease, terminal) {
  return scope.pool.transaction(async client => {
    await scope.pool.current(client, lease, { terminal, readOnly: true, requireUnexpired: true })
    const accounts = (await client.query('SELECT role,user_id,baseline FROM mikka_test_accounts.accounts WHERE pair_id=$1 ORDER BY role', [lease.pairId])).rows
    invariant(accounts.length === 2 && new Set(accounts.map(row => row.role)).size === 2)
    const result = {}
    for (const role of ['owner', 'peer']) {
      const account = accounts.find(row => row.role === role)
      invariant(account && account.user_id === scope[role]?.userId && /^[a-f0-9]{64}$/.test(account.baseline ?? ''))
      const snapshot = summarizeOwned(await scope.pool.ownedRows(client, account.user_id))
      result[role] = { ...snapshot, sealedMatches: snapshot.fingerprint === account.baseline }
    }
    const pair = (await client.query('SELECT blocked_reason FROM mikka_test_accounts.pairs WHERE id=$1 AND environment_id=$2', [lease.pairId, lease.environmentId])).rows
    invariant(pair.length === 1)
    result.reason = pair[0].blocked_reason === null ? null : REASONS.has(pair[0].blocked_reason) ? pair[0].blocked_reason : 'other'
    return result
  }, { readOnly: true })
}

function compare(before, after) {
  const changes = []
  for (const table of new Set([...before.tables.keys(), ...after.tables.keys()])) {
    const a = before.tables.get(table), b = after.tables.get(table)
    if (a?.hash === b?.hash) continue
    const changedFields = [...new Set([...(a?.fields.keys() ?? []), ...(b?.fields.keys() ?? [])])]
      .filter(key => a?.fields.get(key) !== b?.fields.get(key))
    changes.push({
      table: TABLES.has(table) ? table : 'other',
      beforeRows: a?.count ?? 0, afterRows: b?.count ?? 0,
      changedFieldValueSets: changedFields.filter(key => FIELDS.has(key)).sort(),
      otherChangedFieldCount: changedFields.filter(key => !FIELDS.has(key)).length,
    })
  }
  return { matchesSealedBaselineBefore: before.sealedMatches, matchesSealedBaselineAfter: after.sealedMatches, changedTableCount: changes.length, changes }
}

export async function observeAccountRelease(scope) {
  const lease = scope.lease
  const before = await capture(scope, lease, false)
  let previous = before
  const original = scope.pool.release
  let observation = { observed: false }
  async function release(value, options) {
    // A different lease never borrows this observer's account baseline.
    if (value.id !== lease.id || value.generation !== lease.generation || value.environmentId !== lease.environmentId) return Reflect.apply(original, this, [value, options])
    const result = await Reflect.apply(original, this, [value, options])
    try {
      const after = await capture(scope, value, true)
      observation = {
        observed: true,
        state: ['released', 'quarantined'].includes(result?.state) ? result.state : 'other',
        blockedReason: after.reason,
        owner: compare(before.owner, after.owner),
        peer: compare(before.peer, after.peer),
      }
    } catch { observation = { observed: false, failure: 'ACCOUNT_DIAGNOSTIC_READ_FAILED' } }
    return result
  }
  scope.pool.release = release
  return {
    checkpoint: async () => {
      const current = await capture(scope, lease, false)
      const report = { owner: compare(previous.owner, current.owner), peer: compare(previous.peer, current.peer) }
      previous = current
      return report
    },
    read: () => structuredClone(observation),
    restore: () => { if (scope.pool.release === release) scope.pool.release = original },
  }
}
