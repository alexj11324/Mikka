import type { Pool, PoolClient } from 'pg'
import { lockCliRunPolicy, cliPolicyGuard, realCliMembershipGuard, type CliMembershipGuard } from './policy-store'
import { writeTransaction } from '@/lib/operations/write-transaction'

/** No caller identity, policy, decision, or scope comes from the CLI. */
export type DeviceActor = { userId: string; deviceId: string }
export class ApprovalUnavailable extends Error { constructor() { super('approvalUnavailable') } }

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
}
