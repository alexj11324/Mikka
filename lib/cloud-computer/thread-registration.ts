import { escapeLiteral, type PoolClient, type QueryResult } from 'pg'

// A new token is not handed off until its insertion commits; lastUsedAt is null.
export const THREAD_CREDENTIAL_SQL = "INSERT INTO device_tokens (id,\"userId\",name,\"tokenHash\",\"boundDeviceId\",\"boundWorkspaceId\",\"expiresAt\") VALUES ($1,$2,$3,$4,$5,$6,now()+interval '24 hours') RETURNING clock_timestamp() AS now"

export const FINISH_THREAD_REGISTRATION = `UPDATE thread_machines m SET state='running',"lastActiveAt"=now(),"runningSince"=COALESCE(m."runningSince",now()),
"workerLeaseId"=NULL,"workerLeaseUntil"=NULL,"restoreStartedAt"=NULL,"lifecycleAt"=now(),
lifecycle=m.lifecycle||jsonb_build_object('phase',CASE WHEN m.lifecycle->>'phase'='create_requested' THEN 'created' ELSE 'resumed' END,'owner','run-recovery','failures',0)
FROM devices d JOIN device_tokens t ON t."boundDeviceId"=d.id,agent_runs r
WHERE m."runId"=$1 AND m."workerLeaseId"=$2 AND m.state<>'ended'
AND r.id=m."runId" AND r."stopRequestedAt" IS NULL
AND d.id=$3 AND m."deviceId"=d.id AND d."ownerId"=m."ownerId"
AND t."tokenHash"=$4 AND t."revokedAt" IS NULL AND d."lastSeenAt">=$5 AND t."lastUsedAt">=$5
RETURNING m."runId",m."issueId",m."sandboxId",m.epoch,m.lifecycle,m."computeSeconds"`

export type ThreadRegistrationMaintenance = {
  status: 'succeeded' | 'failed' | 'stopped' | 'cancelled'
  /** PostgreSQL's own timestamp text, preserving microseconds on this connection. */
  stopRequestedAt: string | null
}

// Maintenance may retain a historical stop only while its original terminal
// status, exact stop marker and native-exit proof still hold. Ordinary task
// completion never receives this exception.
const maintenanceFence = (statusParameter: number, stopParameter: number) =>
  'r.status=$' + statusParameter + ' AND r."stopRequestedAt"::text IS NOT DISTINCT FROM $' + stopParameter +
  ' AND ($' + stopParameter + '::text IS NULL OR r.report#>>\'{safePoint,session}\'=\'exited\')'

const maintenanceFinish = FINISH_THREAD_REGISTRATION.replace('r."stopRequestedAt" IS NULL', maintenanceFence(6, 7))

/**
 * Preserve run -> machine lock order. The UPDATE is a new statement after any
 * lock wait, so it sees committed revocations. It does not take token locks:
 * credential revocation owns its token before stopping the run.
 */
export async function finishThreadRegistration(client: Pick<PoolClient, 'query'>, runId: string,
  leaseId: string, deviceId: string, tokenSha256: string, startedAt: Date, maintenance?: ThreadRegistrationMaintenance) {
  if (maintenance && (!['succeeded','failed','stopped','cancelled'].includes(maintenance.status) ||
    !(maintenance.stopRequestedAt === null || (typeof maintenance.stopRequestedAt === 'string' &&
      maintenance.stopRequestedAt.length > 0 && maintenance.stopRequestedAt.length <= 128)))) throw new Error('Invalid registration maintenance fence')
  const maintenanceValues = maintenance ? [maintenance.status, maintenance.stopRequestedAt] : []
  await client.query('BEGIN')
  try {
    const held = await client.query(
      'SELECT 1 FROM agent_runs r JOIN thread_machines m ON m."runId"=r.id WHERE r.id=$1 AND ' +
        (maintenance ? maintenanceFence(3, 4) : 'r."stopRequestedAt" IS NULL') +
        ' AND m."workerLeaseId"=$2 AND m.state<>\'ended\' FOR UPDATE OF r,m',
      [runId, leaseId, ...maintenanceValues])
    if (!held.rowCount) {
      await client.query('ROLLBACK')
      return { rowCount: 0, rows: [] }
    }
    const result = await client.query(maintenance ? maintenanceFinish : FINISH_THREAD_REGISTRATION, [runId, leaseId, deviceId, tokenSha256, startedAt, ...maintenanceValues])
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

export type ThreadRegistrationPreparation = {
  runId: string
  deviceId: string
  repoId: string
  ownerId: string
  workspaceId: string
  repoPath: string
  baseBranch: string | null | undefined
  verifyCommand: string | null | undefined
  remoteUrl: string | null | undefined
  tokenId: string
  tokenSha256: string
}

type PreparationStatement = { text: string; values: (string | null | undefined)[] }

function preparationStatements(p: ThreadRegistrationPreparation): PreparationStatement[] {
  return [
    { text: 'INSERT INTO devices (id,"ownerId",name,kind,"nameLocked") VALUES ($1,$2,$3,\'cloud\',true) ON CONFLICT(id) DO UPDATE SET "removedAt"=NULL', values: [p.deviceId,p.ownerId,'Thread computer'] },
    { text: 'INSERT INTO device_repos (id,"deviceId","userId","repoPath","baseBranch","verifyCommand","remoteUrl") VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING', values: [p.repoId,p.deviceId,p.ownerId,p.repoPath,p.baseBranch,p.verifyCommand,p.remoteUrl] },
    { text: 'UPDATE thread_machines SET "deviceId"=$2,"repoId"=$3 WHERE "runId"=$1', values: [p.runId,p.deviceId,p.repoId] },
    { text: 'UPDATE device_tokens SET "revokedAt"=now() WHERE "boundDeviceId"=$1', values: [p.deviceId] },
    { text: THREAD_CREDENTIAL_SQL, values: [p.tokenId,p.ownerId,'Thread worker',p.tokenSha256,p.deviceId,p.workspaceId] },
  ]
}

function preparationBatch(p: ThreadRegistrationPreparation, statements: PreparationStatement[]): string | null {
  // Keep the original bound path for unusual or expanding data. PostgreSQL text
  // read from the admitted repository cannot contain NUL. Do not reinterpret it.
  let valueBytes = 0
  let boundRequestFloor = 0
  for (const statement of statements) {
    // Conservative Parse/Bind/Describe/Execute/Sync framing: at least 40 fixed
    // bytes per unnamed query and four length bytes per parameter. No response
    // savings, timing values or future requests are borrowed for this decision.
    boundRequestFloor += Buffer.byteLength(statement.text) + 40 + 4 * statement.values.length
    for (const value of statement.values) {
      if (value == null) continue
      if (typeof value !== 'string' || value.includes('\0')) return null
      const bytes = Buffer.byteLength(value)
      valueBytes += bytes
      boundRequestFloor += bytes
    }
  }
  // This is only an optimization limit: larger values still use pg parameters.
  if (valueBytes > 64 * 1024) return null
  const literal = (value: string | null | undefined, type: 'uuid' | 'text') =>
    (value == null ? 'NULL' : escapeLiteral(value)) + '::' + type
  const device = literal(p.deviceId,'uuid'), owner = literal(p.ownerId,'text'), repo = literal(p.repoId,'uuid')
  const text = `INSERT INTO devices (id,"ownerId",name,kind,"nameLocked") VALUES (${device},${owner},'Thread computer','cloud',true) ON CONFLICT(id) DO UPDATE SET "removedAt"=NULL;
INSERT INTO device_repos (id,"deviceId","userId","repoPath","baseBranch","verifyCommand","remoteUrl") VALUES (${repo},${device},${owner},${literal(p.repoPath,'text')},${literal(p.baseBranch,'text')},${literal(p.verifyCommand,'text')},${literal(p.remoteUrl,'text')}) ON CONFLICT(id) DO NOTHING;
UPDATE thread_machines SET "deviceId"=${device},"repoId"=${repo} WHERE "runId"=${literal(p.runId,'uuid')};
UPDATE device_tokens SET "revokedAt"=now() WHERE "boundDeviceId"=${device};
INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES (${literal(p.tokenId,'uuid')},${owner},'Thread worker',${literal(p.tokenSha256,'text')},${device},${literal(p.workspaceId,'uuid')},now()+interval '24 hours') RETURNING clock_timestamp() AS now`
  // The existing egress sampler scans SQL literals too. Only this batch's exact
  // static match sequence (including ON CONFLICT's UPDATE SET) may be sampled.
  // Inspect escaped SQL without truncation or deduplication; extra value matches
  // retain all five original bound statements, regardless of sampling settings.
  const tables = [...text.matchAll(/\b(?:from|join|into|update)\s+(?:only\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)].map(match => match[1])
  if (tables.join(',') !== 'devices,SET,device_repos,thread_machines,device_tokens,device_tokens') return null
  return Buffer.byteLength(text) + 6 <= boundRequestFloor ? text : null
}

/**
 * Five DML statements, one network round trip when literal encoding saves bytes.
 * The caller retains its transaction, run/machine locks and later fresh rebind.
 * No COMMIT, function, CTE snapshot, changed authority or credential publication.
 */
export async function prepareThreadRegistration(client: Pick<PoolClient, 'query'>, input: ThreadRegistrationPreparation): Promise<{ now: Date }> {
  const statements = preparationStatements(input)
  const batch = preparationBatch(input, statements)
  if (batch === null) {
    let last: QueryResult<{ now: Date }> | undefined
    for (const statement of statements) last = await client.query<{ now: Date }>(statement.text, statement.values)
    return last!.rows[0]
  }
  // No values array or prepared name: pg must return the five native results.
  const results: unknown = await client.query(batch)
  const commands = ['INSERT','INSERT','UPDATE','UPDATE','INSERT']
  if (!Array.isArray(results) || results.length !== commands.length ||
    results.some((result, index) => !result || result.command !== commands[index] || !Array.isArray(result.rows) ||
      !Number.isInteger(result.rowCount) || result.rowCount < 0 ||
      (index < 4 ? result.rows.length !== 0 : result.rows.length !== 1))) throw new TypeError('Invalid thread credential preparation results')
  const issued = results[4].rows[0]
  if (!(issued?.now instanceof Date) || !Number.isFinite(issued.now.getTime())) throw new TypeError('Invalid thread credential preparation clock')
  return issued
}
