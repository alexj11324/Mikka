import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { recordAudit } from '@/lib/audit/write'
import { lockCliRunPolicy, cliPolicyGuard, realCliMembershipGuard, type CliMembershipGuard } from './policy-store'
import { writeTransaction } from '@/lib/operations/write-transaction'

/** No caller identity, policy, decision, or scope comes from the CLI. */
export type DeviceActor = { userId: string; deviceId: string }
export type ApprovalInput = { runId: string; requestId: string; harness: 'codex' | 'claude_code'; method: string; input: unknown; policyRevision: string; /** #438 E: the unmasked input when `input` was masked; only its sha256 is kept. */ originalInput?: unknown }
export class ApprovalUnavailable extends Error { constructor() { super('approvalUnavailable') } }

const validate = (value: ApprovalInput) => {
  const serialized = JSON.stringify(value.input)
  if (!value.requestId || value.requestId.length > 256 || !value.method || value.method.length > 128 || !serialized || serialized.length > 20_000) throw new ApprovalUnavailable()
  const digest = createHash('sha256').update(JSON.stringify([value.runId, value.requestId, value.harness, value.method, value.policyRevision, JSON.parse(serialized)])).digest('hex')
  // #438 E: compared on a repeated requestId, never returned.
  const inputDigest = createHash('sha256').update(JSON.stringify([value.runId, value.requestId, 'originalInput' in value ? value.originalInput : JSON.parse(serialized)])).digest('hex')
  return { serialized, digest, inputDigest }
}

export class AgentToolApprovalStore {
  constructor(private readonly pool: Pick<Pool, 'connect' | 'query'>, private readonly membership: CliMembershipGuard = realCliMembershipGuard) {}
  /** Locks the run before every state mutation so stop, lease and ownership are checked. */
  private async transaction<T>(runId: string, userId: string, work: (client: PoolClient) => Promise<T>, allowPaused = false): Promise<T> {
    return writeTransaction(this.pool, async client => {
      const run = await client.query(`SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 AND status=ANY($3::text[]) AND "stopRequestedAt" IS NULL AND "leaseExpiresAt">now() FOR UPDATE`, [runId, userId, ['preparing','running','waiting_input', ...(allowPaused ? ['paused'] : [])]])
      if (!run.rowCount) throw new ApprovalUnavailable()
      return work(client)
    }, { guard: cliPolicyGuard(runId,userId,this.membership) })
  }
  /** Authenticated distribution only; snapshots never replace live tool authorization. */
  async policyDistribution(actor: DeviceActor, runId: string, revision?: string) {
    return this.transaction(runId, actor.userId, async client => {
      const owned = await client.query('SELECT id FROM agent_runs WHERE id=$1 AND "deviceId"=$2',[runId,actor.deviceId])
      if (!owned.rowCount) throw new ApprovalUnavailable()
      const current = await lockCliRunPolicy(client,runId,actor.userId)
      if (revision && current.revision !== revision) throw new ApprovalUnavailable()
      return current
    }, true)
  }
  async check(actor: DeviceActor, runId: string, revision: string) {
    const state = await this.checkState(actor, runId, revision)
    return state.live && !state.paused
  }
  async checkState(actor: DeviceActor, runId: string, revision: string) {
    return this.transaction(runId, actor.userId, async client => {
      // The existing desktop control lease expires without a new timer. A
      // liveness poll restores the held session once that lease has expired.
      const current = await client.query('SELECT status FROM agent_runs WHERE id=$1 AND "deviceId"=$2', [runId, actor.deviceId])
      if (current.rows[0]?.status === 'paused') await client.query(`UPDATE agent_runs r SET status=COALESCE(r."resumeStatus",'running'),"resumeStatus"=NULL,"pauseReason"=NULL,"updatedAt"=now()
        FROM computer_run_bindings b JOIN bot_desktops d ON d."botId"=b."botId" AND d."ownerId"=b."ownerId" AND d."workspaceId"=b."workspaceId"
        WHERE r.id=$1 AND b."runId"=r.id AND b."ownerId"=r."userId" AND r.status='paused' AND r."pauseReason"='human_control'
          AND (d.control<>'user' OR d."controlUntil" IS NULL OR d."controlUntil"<=now())`, [runId])
      const row = current.rows[0]?.status === 'paused'
        ? await client.query('SELECT status FROM agent_runs WHERE id=$1 AND "deviceId"=$2', [runId, actor.deviceId])
        : current
      if (!row.rowCount) throw new ApprovalUnavailable()
      return { live: (await lockCliRunPolicy(client, runId, actor.userId)).revision === revision, paused: row.rows[0].status === 'paused' }
    }, true)
  }
  async propose(actor: DeviceActor, value: ApprovalInput) {
    const { serialized, digest, inputDigest } = validate(value)
    return this.transaction(value.runId, actor.userId, async client => {
      const policy = await lockCliRunPolicy(client, value.runId, actor.userId)
      if (policy.revision !== value.policyRevision) throw new ApprovalUnavailable()
      if (value.method === 'sandbox/network' && policy.policy.permissions.network === 'deny') throw new ApprovalUnavailable()
      const valid = await client.query(`SELECT 1 FROM agent_runs r JOIN agents a ON a.id=r."agentId" AND a."userId"=r."userId" JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId" AND d.enabled=true WHERE r.id=$1 AND r."deviceId"=$2 AND COALESCE(r."agentDefinition"->>'harness', a.harness)=$3`, [value.runId, actor.deviceId, value.harness])
      if (!valid.rowCount) throw new ApprovalUnavailable()
      const id = randomUUID()
      const { rows } = await client.query(`INSERT INTO agent_tool_approvals (id,"runId","userId","deviceId","requestId",harness,method,input,digest,status,"expiresAt","policyRevision","inputDigest") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'pending',now()+interval '5 minutes',$10,$11) ON CONFLICT ("runId","requestId") DO UPDATE SET "requestId"=EXCLUDED."requestId" WHERE agent_tool_approvals.digest=EXCLUDED.digest AND agent_tool_approvals."inputDigest"=EXCLUDED."inputDigest" AND agent_tool_approvals."userId"=EXCLUDED."userId" AND agent_tool_approvals."deviceId"=EXCLUDED."deviceId" RETURNING id,digest,status`, [id,value.runId,actor.userId,actor.deviceId,value.requestId,value.harness,value.method,serialized,digest,value.policyRevision,inputDigest])
      if (!rows[0]) throw new ApprovalUnavailable()
      return rows[0] as { id: string; digest: string; status: string }
    }, true)
  }
  async decide(userId: string, runId: string, id: string, digest: string, decision: 'approve' | 'deny', human?: { name: string }) {
    return this.transaction(runId, userId, async client => {
      const policy = await lockCliRunPolicy(client, runId, userId)
      const { rows } = await client.query(`UPDATE agent_tool_approvals SET status=$5,"decidedAt"=now() WHERE id=$1 AND "runId"=$2 AND "userId"=$3 AND digest=$4 AND "policyRevision"=$6 AND status='pending' AND "expiresAt">now() RETURNING status`, [id,runId,userId,digest,decision === 'approve' ? 'approved' : 'denied',policy.revision])
      if (!rows[0]) throw new ApprovalUnavailable()
      for (const workspaceId of policy.workspaceIds) await recordAudit(drizzle(client), { workspaceId,
        actor: human ? { type: 'user', id: userId, name: human.name } : { type: 'system' }, action: 'agent.approval_decided',
        target: { type: 'approval', id }, metadata: { runId, decision: rows[0].status, revision: policy.revision } })
      return rows[0] as { status: string }
    })
  }
  /** Consume before returning approval; retry can never issue a second permit. */
  async take(actor: DeviceActor, runId: string, id: string, digest: string) {
    return this.transaction(runId, actor.userId, async client => {
      const state = await client.query('SELECT status FROM agent_runs WHERE id=$1 AND "deviceId"=$2', [runId,actor.deviceId])
      if (!state.rowCount) throw new ApprovalUnavailable()
      if (state.rows[0].status === 'paused') return 'pending' as const
      const policy = await lockCliRunPolicy(client, runId, actor.userId)
      const { rows } = await client.query(`UPDATE agent_tool_approvals SET status='consumed' WHERE id=$1 AND "runId"=$2 AND "userId"=$3 AND "deviceId"=$4 AND digest=$5 AND "policyRevision"=$6 AND status='approved' AND "expiresAt">now() RETURNING status`, [id,runId,actor.userId,actor.deviceId,digest,policy.revision])
      if (rows[0]) {
        for (const workspaceId of policy.workspaceIds) await recordAudit(drizzle(client), { workspaceId,
          actor: { type: 'system', id: actor.deviceId, name: 'Mikka device' }, action: 'agent.approval_consumed',
          target: { type: 'approval', id }, metadata: { runId, revision: policy.revision } })
        return 'allow' as const
      }
      const found = await client.query(`SELECT status FROM agent_tool_approvals WHERE id=$1 AND "runId"=$2 AND "userId"=$3 AND "deviceId"=$4 AND digest=$5 AND "policyRevision"=$6 AND "expiresAt">now()`, [id,runId,actor.userId,actor.deviceId,digest,policy.revision])
      if (!found.rows[0]) throw new ApprovalUnavailable()
      return found.rows[0].status === 'pending' ? 'pending' as const : 'deny' as const
    }, true)
  }
  async cancel(actor: DeviceActor, runId: string, id: string, digest: string) {
    const { rowCount } = await this.pool.query(`UPDATE agent_tool_approvals SET status='cancelled',"decidedAt"=now() WHERE id=$1 AND "runId"=$2 AND "userId"=$3 AND "deviceId"=$4 AND digest=$5 AND status IN ('pending','approved')`, [id,runId,actor.userId,actor.deviceId,digest])
    return Boolean(rowCount)
  }
  async list(userId: string, runId: string) {
    return this.transaction(runId, userId, async client => {
      const policy = await lockCliRunPolicy(client, runId, userId)
      const { rows } = await client.query(`SELECT a.id,a."runId",a.harness,a.method,a.input,a.digest,a."expiresAt" FROM agent_tool_approvals a WHERE a."userId"=$1 AND a."runId"=$2 AND a."policyRevision"=$3 AND a.status='pending' AND a."expiresAt">now() ORDER BY a."createdAt" LIMIT 20`, [userId,runId,policy.revision])
      return rows
    })
  }
}
