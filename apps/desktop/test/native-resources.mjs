import { TestAccountError, TestAccountPool } from '../../../scripts/test-accounts/pool.mjs'

const quote = name => `"${name.replaceAll('"', '""')}"`
const fail = code => { throw new TestAccountError(code) }
const definitions = {
  devices: { key: 'id', owner: 'ownerId' },
  device_tokens: { key: 'id', owner: 'userId' },
  device_enrollments: { key: 'tokenHash', owner: 'userId' },
  desktop_auth_requests: { key: 'stateHash', owner: 'userId' },
  agents: { key: 'id', owner: 'userId' },
  device_repos: { key: 'id', owner: 'userId' },
  device_token_devices: { key: ['tokenId', 'deviceId'], owner: 'userId' },
  device_management_commands: { key: 'id' },
}
const keyOf = (table, row) => JSON.stringify([definitions[table].key].flat().map(key => row[key]))

async function snapshot(client, owners, lock = false) {
  const result = new Map()
  for (const [table, definition] of Object.entries(definitions)) {
    const condition = definition.owner ? `t.${quote(definition.owner)}=ANY($1::text[])`
      : 't."deviceId" IN (SELECT id FROM devices WHERE "ownerId"=ANY($1::text[]))'
    const rows = (await client.query(`SELECT to_jsonb(t)::text AS data FROM public.${quote(table)} t WHERE ${condition} LIMIT 1001${lock ? ' FOR UPDATE OF t' : ''}`, [owners])).rows
    if (rows.length > 1000) fail('NATIVE_RESOURCE_FOOTPRINT_UNPROVEN')
    result.set(table, new Map(rows.map(({ data }) => {
      const value = JSON.parse(data)
      return [keyOf(table, value), { text: data, value }]
    })))
  }
  return result
}

function difference(baseline, current) {
  const delta = new Map()
  for (const [table, before] of baseline) {
    const after = current.get(table)
    for (const [id, row] of before) if (after.get(id)?.text !== row.text) fail('NATIVE_RESOURCE_BASELINE_CHANGED')
    delta.set(table, new Map([...after].filter(([id]) => !before.has(id))))
  }
  return delta
}

function validateDelta(delta, owners, capturedAt) {
  const rows = table => [...delta.get(table).values()].map(row => row.value)
  const devices = new Map(rows('devices').map(row => [row.id, row]))
  const tokens = new Map(rows('device_tokens').map(row => [row.id, row]))
  const ownedDevice = (id, userId) => devices.get(id)?.ownerId === userId
  for (const row of rows('devices')) if (row.kind !== 'local' || !owners.includes(row.ownerId)) fail('NATIVE_RESOURCE_UNRELATED')
  for (const row of rows('device_tokens')) if (row.name !== 'SSH' || row.boundDeviceId !== null || row.boundWorkspaceId !== null || !owners.includes(row.userId)) fail('NATIVE_RESOURCE_UNRELATED')
  for (const row of rows('agents')) {
    // ensureDeviceAgents creates this infrastructure identity. A removed CLI
    // may have detached it, but the generated name still identifies its device.
    const deviceId = row.name.slice(row.harness.length + 1)
    if (!['claude_code', 'codex', 'cursor', 'mock'].includes(row.harness) || row.name !== `${row.harness} ${deviceId}`
      || !ownedDevice(deviceId, row.userId) || (row.deviceId !== null && row.deviceId !== deviceId)
      || row.description !== '' || row.instructions !== '') fail('NATIVE_RESOURCE_UNRELATED')
  }
  for (const row of rows('device_repos')) if (!ownedDevice(row.deviceId, row.userId)) fail('NATIVE_RESOURCE_UNRELATED')
  for (const row of rows('device_token_devices')) if (!ownedDevice(row.deviceId, row.userId) || tokens.get(row.tokenId)?.userId !== row.userId) fail('NATIVE_RESOURCE_UNRELATED')
  for (const row of rows('device_management_commands')) if (!devices.has(row.deviceId)) fail('NATIVE_RESOURCE_UNRELATED')
  for (const row of rows('desktop_auth_requests')) {
    let callback
    try { callback = new URL(row.callback) } catch { fail('NATIVE_RESOURCE_UNRELATED') }
    if (callback.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(callback.hostname) || !callback.port
      || callback.pathname !== '/auth/callback' || callback.username || callback.password || callback.search || callback.hash
      || new Date(row.createdAt).getTime() < capturedAt) fail('NATIVE_RESOURCE_UNRELATED')
  }
}

async function rejectUnrelatedReferences(client, delta) {
  const targets = ['devices', 'agents', 'device_tokens', 'device_repos']
  // Consult real FKs as well as the existing logical references whose older
  // test schemas do not have FKs. No cascade can silently remove a run, cloud
  // machine, review, revocation receipt, or another owner's linked row.
  const edges = (await client.query(`SELECT child.relname AS child, parent.relname AS parent, ca.attname AS column
    FROM pg_constraint fk JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_namespace cn ON cn.oid=child.relnamespace
    JOIN pg_class parent ON parent.oid=fk.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace
    JOIN LATERAL unnest(fk.conkey,fk.confkey) AS key(child_number,parent_number) ON true
    JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=key.child_number
    JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=key.parent_number
    WHERE fk.contype='f' AND cn.nspname='public' AND pn.nspname='public' AND pa.attname='id' AND parent.relname=ANY($1::text[])`, [targets])).rows
  const logical = { deviceId: 'devices', boundDeviceId: 'devices', agentId: 'agents', deviceRepoId: 'device_repos', deviceTokenId: 'device_tokens', tokenId: 'device_tokens' }
  const columns = (await client.query(`SELECT c.table_name AS child,c.column_name AS column FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.table_schema='public' AND t.table_type='BASE TABLE' AND c.column_name=ANY($1::text[])`, [Object.keys(logical)])).rows
  for (const column of columns) edges.push({ ...column, parent: logical[column.column] })
  for (const { child, parent, column } of new Map(edges.map(edge => [JSON.stringify([edge.child, edge.parent, edge.column]), edge])).values()) {
    const ids = [...delta.get(parent).values()].map(row => row.value.id)
    if (!ids.length) continue
    const linked = (await client.query(`SELECT to_jsonb(t)::text AS data FROM public.${quote(child)} t WHERE t.${quote(column)}::text=ANY($1::text[]) LIMIT 1001`, [ids])).rows
    if (linked.length > 1000) fail('NATIVE_RESOURCE_FOOTPRINT_UNPROVEN')
    for (const { data } of linked) {
      if (!definitions[child] || delta.get(child).get(keyOf(child, JSON.parse(data)))?.text !== data) fail('NATIVE_RESOURCE_REFERENCED')
    }
  }
}

/**
 * Capture before Electron starts. The real lease and DB marker authorize only
 * its owner/peer. Call cleanup only after cancelling installers, closing the
 * windows and awaiting stopLocalDaemons(profiles). No product path is mocked.
 */
export async function captureNativeResources(scope) {
  if (!(scope?.pool instanceof TestAccountPool)) fail('NATIVE_RESOURCE_SCOPE_REQUIRED')
  const owners = [scope.owner?.userId, scope.peer?.userId]
  if (owners.some(owner => typeof owner !== 'string' || !owner) || owners[0] === owners[1]) fail('NATIVE_RESOURCE_SCOPE_REQUIRED')
  const lease = { ...scope.lease }
  async function transaction(work) {
    await scope.assertActive()
    return scope.pool.transaction(async client => {
      await scope.pool.current(client, lease)
      const accounts = (await client.query('SELECT role,user_id FROM mikka_test_accounts.accounts WHERE pair_id=$1 ORDER BY role', [lease.pairId])).rows
      if (accounts.length !== 2 || accounts[0].role !== 'owner' || accounts[0].user_id !== owners[0] || accounts[1].role !== 'peer' || accounts[1].user_id !== owners[1]) fail('NATIVE_RESOURCE_SCOPE_MISMATCH')
      const value = await work(client)
      await scope.pool.current(client, lease)
      return value
    })
  }
  const { baseline, capturedAt } = await transaction(async client => ({
    capturedAt: new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime(),
    baseline: await snapshot(client, owners),
  }))
  return {
    async cleanup({ drained } = {}) {
      if (drained !== true) fail('NATIVE_DAEMONS_NOT_DRAINED')
      return transaction(async client => {
        const delta = difference(baseline, await snapshot(client, owners, true))
        validateDelta(delta, owners, capturedAt)
        await rejectUnrelatedReferences(client, delta)
        const counts = {}
        // Keys and owners came from this guarded before/after difference, not
        // from renderer input. Enrollment hashes stay private in this closure.
        // Closing every window also cancels its auth loopback. A newly bound
        // lease-owned handoff can now be removed whether exchanged or cancelled.
        for (const table of ['desktop_auth_requests', 'device_token_devices', 'device_management_commands', 'device_repos', 'agents', 'device_tokens', 'device_enrollments', 'devices']) {
          const definition = definitions[table]
          const rows = [...delta.get(table).values()].map(row => row.value)
          for (const row of rows) {
            const keys = [definition.key].flat()
            const values = keys.map(key => row[key])
            const conditions = keys.map((key, index) => `${quote(key)}::text=$${index + 1}`)
            if (definition.owner) { values.push(row[definition.owner]); conditions.push(`${quote(definition.owner)}=$${values.length}`) }
            const result = await client.query(`DELETE FROM public.${quote(table)} WHERE ${conditions.join(' AND ')}`, values)
            if (result.rowCount !== 1) fail('NATIVE_RESOURCE_CLEANUP_MISMATCH')
          }
          counts[table] = rows.length
        }
        const remaining = difference(baseline, await snapshot(client, owners))
        if ([...remaining.values()].some(rows => rows.size)) fail('NATIVE_RESOURCE_CLEANUP_MISMATCH')
        return { cleaned: true, counts }
      })
    },
  }
}
