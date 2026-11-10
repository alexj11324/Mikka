import { createHash } from 'node:crypto'

const digest = value => createHash('sha256').update(value).digest('hex')
const kinds = Object.freeze({ issues: 'task', agent_runs: 'thread', bots: 'bot', artifacts: 'artifact' })

/** Test-account receipts preserve immutable audit history, not application data.
 * Only a previously reserved synthetic source that is now absent can qualify.
 * No public table is updated, no trigger is disabled, and no table is ignored. */
export async function retainDeletedResourceAudit(client, lease, resource, fail) {
  const catalog = (await client.query("SELECT to_regclass('public.resource_access_events') AS events, to_regclass('public.run_resource_disclosures') AS disclosures")).rows[0]
  if (!catalog.events) return
  const references = []
  if (kinds[resource.type]) references.push([kinds[resource.type], resource.id])
  if (resource.type === 'bots' || resource.type === 'coordinator_sessions') {
    const { rows: [chat] } = await client.query('SELECT mikka_chat_resource_id($1,$2::uuid) AS id', [resource.owner_id, resource.id])
    if ((await client.query('SELECT 1 FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2::uuid', [resource.owner_id, resource.id])).rowCount) fail('RESOURCE_STILL_PRESENT')
    references.push(['chat', chat.id])
  }
  for (const [kind, id] of references) {
    if ((await client.query('SELECT 1 FROM resource_access_policies WHERE kind=$1 AND id=$2::uuid', [kind, id])).rowCount) fail('RESOURCE_STILL_PRESENT')
    const { rows } = await client.query(`SELECT e.id,to_jsonb(e)::text AS data,e."ownerId",e."workspaceId",e.action,e.source,e."createdAt",
      e."createdAt">=r.created_at AND e."createdAt">=l.created_at AS in_lease
      FROM resource_access_events e CROSS JOIN mikka_test_accounts.resources r
      JOIN mikka_test_accounts.leases l ON l.id=r.lease_id
      WHERE e."resourceKind"=$1 AND e."resourceId"=$2::uuid AND r.lease_id=$3 AND r.type=$4 AND r.id=$5
      ORDER BY e."createdAt",e.id`, [kind,id,lease.id,resource.type,resource.id])
    if (!rows.length) continue
    if (rows.some(row => !row.in_lease || row.ownerId !== resource.owner_id)
      || !rows.some(row => row.action === 'insert' && row.source === 'resource_registration')
      || !rows.some(row => row.action === 'delete' && row.source === 'source_deleted')) fail('RESOURCE_AUDIT_UNPROVEN')
    for (const row of rows) await receipt(client,lease,resource,'resource_access_events',row.id,row.data,row.workspaceId)
  }
  if (resource.type === 'agent_runs' && catalog.disclosures) {
    const { rows } = await client.query(`SELECT d."runId"::text||':'||d.attempt AS id,to_jsonb(d)::text AS data,d."workspaceId",
      d."ownerId"=$2 AND d."createdAt">=r.created_at AND (d."deviceId" IS NULL OR NOT EXISTS(
        SELECT 1 FROM devices v WHERE v.id=d."deviceId" AND v."removedAt" IS NULL)) AS eligible
      FROM run_resource_disclosures d CROSS JOIN mikka_test_accounts.resources r
      WHERE d."runId"=$1::uuid AND r.lease_id=$3 AND r.type='agent_runs' AND r.id=$1`, [resource.id,resource.owner_id,lease.id])
    if (rows.some(row => !row.eligible)) fail('RESOURCE_AUDIT_UNPROVEN')
    for (const row of rows) await receipt(client,lease,resource,'run_resource_disclosures',row.id,row.data,row.workspaceId)
  }
}

async function receipt(client,lease,resource,table,id,data,workspaceId) {
  await client.query(`INSERT INTO mikka_test_accounts.retained_audit
    (lease_id,source_type,source_id,owner_id,table_name,record_id,workspace_id,fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(table_name,record_id) DO NOTHING`,
  [lease.id,resource.type,resource.id,resource.owner_id,table,id,workspaceId,digest(data)])
}

/** Exact, content-addressed receipts only. Other events, a changed row or a
 * foreign lease still changes the account's baseline and prevents reuse. */
export async function retainedAuditFingerprints(client,userId) {
  // Standalone read-only footprint checks also run before a pool is prepared.
  // Without its receipt table no audit row is excluded from the fingerprint.
  const { rows: [catalog] } = await client.query("SELECT to_regclass('mikka_test_accounts.retained_audit') AS receipts")
  if (!catalog.receipts) return new Map()
  const { rows } = await client.query(`SELECT a.table_name,a.record_id,a.fingerprint FROM mikka_test_accounts.retained_audit a
    JOIN mikka_test_accounts.resources r ON r.lease_id=a.lease_id AND r.type=a.source_type AND r.id=a.source_id
    JOIN mikka_test_accounts.leases l ON l.id=a.lease_id
    WHERE a.owner_id=$1 AND r.owner_id=$1 AND r.state='cleaned' AND l.state IN ('active','released')`, [userId])
  return new Map(rows.map(row => [`${row.table_name}:${row.record_id}`,row.fingerprint]))
}

export function retainedAuditMatches(table,row,receipts) {
  const id = table === 'resource_access_events' ? row.value.id
    : table === 'run_resource_disclosures' ? `${row.value.runId}:${row.value.attempt}` : null
  return id !== null && receipts.get(`${table}:${id}`) === digest(row.text)
}
