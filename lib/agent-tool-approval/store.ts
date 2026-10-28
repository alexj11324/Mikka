import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

/** No caller identity, policy, decision, or scope comes from the CLI. */
export type DeviceActor = { userId: string; deviceId: string }
export type ApprovalInput = { runId: string; requestId: string; harness: 'codex' | 'claude_code'; method: string; input: unknown }
export class ApprovalUnavailable extends Error { constructor() { super('approvalUnavailable') } }

const validate = (value: ApprovalInput) => {
  const serialized = JSON.stringify(value.input)
  if (!value.requestId || value.requestId.length > 256 || !value.method || value.method.length > 128 || !serialized || serialized.length > 20_000) throw new ApprovalUnavailable()
  const digest = createHash('sha256').update(JSON.stringify([value.runId, value.requestId, value.harness, value.method, JSON.parse(serialized)])).digest('hex')
  return { serialized, digest }
}

export class AgentToolApprovalStore {
  constructor(private readonly pool: Pick<Pool, 'connect' | 'query'>) {}
  /** Locks the run before every state mutation so stop, lease and ownership are checked. */
  private async transaction<T>(runId: string, userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const run = await client.query(`SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 AND status IN ('preparing','running','waiting_input') AND "stopRequestedAt" IS NULL AND "leaseExpiresAt">now() FOR UPDATE`, [runId, userId])
      if (!run.rowCount) throw new ApprovalUnavailable()
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  async propose(actor: DeviceActor, value: ApprovalInput) {
    const { serialized, digest } = validate(value)
    return this.transaction(value.runId, actor.userId, async client => {
      const valid = await client.query(`SELECT 1 FROM agent_runs r JOIN agents a ON a.id=r."agentId" AND a."userId"=r."userId" JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId" AND d.enabled=true WHERE r.id=$1 AND r."deviceId"=$2 AND COALESCE(r."agentDefinition"->>'harness', a.harness)=$3`, [value.runId, actor.deviceId, value.harness])
      if (!valid.rowCount) throw new ApprovalUnavailable()
      const id = randomUUID()
      const { rows } = await client.query(`INSERT INTO agent_tool_approvals (id,"runId","userId","deviceId","requestId",harness,method,input,digest,status,"expiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'pending',now()+interval '5 minutes') ON CONFLICT ("runId","requestId") DO UPDATE SET "requestId"=EXCLUDED."requestId" WHERE agent_tool_approvals.digest=EXCLUDED.digest AND agent_tool_approvals."userId"=EXCLUDED."userId" AND agent_tool_approvals."deviceId"=EXCLUDED."deviceId" RETURNING id,digest,status`, [id,value.runId,actor.userId,actor.deviceId,value.requestId,value.harness,value.method,serialized,digest])
      if (!rows[0]) throw new ApprovalUnavailable()
      return rows[0] as { id: string; digest: string; status: string }
    })
  }
  async decide(userId: string, runId: string, id: string, digest: string, decision: 'approve' | 'deny') {
    return this.transaction(runId, userId, async client => {
      const { rows } = await client.query(`UPDATE agent_tool_approvals SET status=$5,"decidedAt"=now() WHERE id=$1 AND "runId"=$2 AND "userId"=$3 AND digest=$4 AND status='pending' AND "expiresAt">now() RETURNING status`, [id,runId,userId,digest,decision === 'approve' ? 'approved' : 'denied'])
      if (!rows[0]) throw new ApprovalUnavailable()
      return rows[0] as { status: string }
    })
  }
  /** Consume before returning approval; retry can never issue a second permit. */
  async take(actor: DeviceActor, runId: string, id: string, digest: string) {
    return this.transaction(runId, actor.userId, async client => {
      const { rows } = await client.query(`UPDATE agent_tool_approvals SET status='consumed' WHERE id=$1 AND "runId"=$2 AND "userId"=$3 AND "deviceId"=$4 AND digest=$5 AND status='approved' AND "expiresAt">now() RETURNING status`, [id,runId,actor.userId,actor.deviceId,digest])
      if (rows[0]) return 'allow' as const
      const found = await client.query(`SELECT status FROM agent_tool_approvals WHERE id=$1 AND "runId"=$2 AND "userId"=$3 AND "deviceId"=$4 AND digest=$5 AND "expiresAt">now()`, [id,runId,actor.userId,actor.deviceId,digest])
      if (!found.rows[0]) throw new ApprovalUnavailable()
      return found.rows[0].status === 'pending' ? 'pending' as const : 'deny' as const
    })
  }
  async cancel(actor: DeviceActor, runId: string, id: string, digest: string) {
    const { rowCount } = await this.pool.query(`UPDATE agent_tool_approvals SET status='cancelled',"decidedAt"=now() WHERE id=$1 AND "runId"=$2 AND "userId"=$3 AND "deviceId"=$4 AND digest=$5 AND status IN ('pending','approved')`, [id,runId,actor.userId,actor.deviceId,digest])
    return Boolean(rowCount)
  }
  async list(userId: string, runId: string) {
    const { rows } = await this.pool.query(`SELECT a.id,a."runId",a.harness,a.method,a.input,a.digest,a."expiresAt" FROM agent_tool_approvals a JOIN agent_runs r ON r.id=a."runId" AND r."userId"=a."userId" WHERE a."userId"=$1 AND a."runId"=$2 AND a.status='pending' AND a."expiresAt">now() AND r.status IN ('preparing','running','waiting_input') AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now() ORDER BY a."createdAt" LIMIT 20`, [userId,runId])
    return rows
  }
}
