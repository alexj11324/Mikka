import type { Pool, PoolClient } from 'pg'
import { lockCliRunPolicy, cliPolicyGuard, policyMemberships, realCliMembershipGuard, type CliMembershipGuard } from './policy-store'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { runChanged } from '@/lib/live/panels'
import { runListChanged } from '@/lib/live/lists'

/** No caller identity, policy, decision, or scope comes from the CLI. */
export type DeviceActor = { userId: string; deviceId: string }
export type ApprovalRevokeReason = 'device_lost' | 'policy_changed' | 'expired' | 'not_pending'
export class ApprovalUnavailable extends Error { constructor(readonly revokeReason?: ApprovalRevokeReason) { super('approvalUnavailable') } }

export class AgentToolApprovalStore {
  constructor(private readonly pool: Pick<Pool, 'connect' | 'query'>, private readonly membership: CliMembershipGuard = realCliMembershipGuard) {}
  /** Locks the run before every state mutation so stop, lease and ownership are checked. */
  private async transaction<T>(runId: string, userId: string, work: (client: PoolClient) => Promise<T>, allowPaused = false, liveness?: { deviceId: string; revision: string }, guard = cliPolicyGuard(runId,userId,this.membership)): Promise<T> {
    const result = await writeTransaction<{ unavailable: ApprovalUnavailable } | { value: T }>(this.pool, async client => {
      const run = await client.query(`SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 AND status=ANY($3::text[]) AND "stopRequestedAt" IS NULL AND "leaseExpiresAt">now() FOR UPDATE`, [runId, userId, ['preparing','running','waiting_input', ...(allowPaused ? ['paused'] : [])]])
      if (!run.rowCount) {
        const reason = liveness ? await this.revocationReason(client, runId, userId, liveness.deviceId) : undefined
        if (!reason || !liveness || (await lockCliRunPolicy(client,runId,userId)).revision !== liveness.revision) throw new ApprovalUnavailable()
        // A typed refusal still passes the existing policy/member guard before
        // it leaves the transaction. Throwing here would skip that guard.
        return { unavailable: new ApprovalUnavailable(reason) }
      }
      return { value: await work(client) }
    }, { guard })
    if ('unavailable' in result) throw result.unavailable
    return result.value
  }
  /** Classification only: this never makes an unavailable run live. */
  private async revocationReason(client: PoolClient, runId: string, userId: string, deviceId: string): Promise<'device_lost' | undefined> {
    // Lock the exact owned device/run before reading host records, including
    // after a lock wait. transaction() then checks the policy/member fence.
    const { rows: [run] } = await client.query(`SELECT "stopRequestedAt", "leaseExpiresAt"<=now() AS expired
      FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3
        AND status=ANY($4::text[]) FOR UPDATE`, [runId,userId,deviceId,['preparing','running','waiting_input','paused']])
    if (!run) return
    if (!run.stopRequestedAt) return run.expired ? 'device_lost' : undefined
    // A stop flag alone also covers the person's Stop. Only the current
    // epoch's host watchdog receipt proves this server-initiated revocation.
    const proof = await client.query(`SELECT 1 FROM factory_attempts a
      JOIN factory_tasks t ON t.id=a."taskId" AND t."userId"=$2
      JOIN factory_events e ON e."taskId"=t.id
      WHERE a."runId"=$1 AND t.status NOT IN ('cancelled','revoked')
        AND a.output->>'requestEpoch'=t."sourceEventId"::text
        AND a.output#>>'{watchdog,requestEpoch}'=t."sourceEventId"::text
        AND a.output#>>'{watchdog,reasonCode}'='task_stalled'
        AND e.request->>'kind'='task_watchdog'
        AND e.request->>'attemptId'=a.id::text
        AND e.request->>'requestEpoch'=t."sourceEventId"::text
        AND e.result->>'action'='stalled' AND e.result->>'blocked'='true'
      LIMIT 1`, [runId,userId])
    return proof.rowCount ? 'device_lost' : undefined
  }
  /** Authenticated distribution only; snapshots never replace live tool authorization. */
  async policyDistribution(actor: DeviceActor, runId: string, revision?: string) {
    // Like readCliRunPolicy, retain these APP locks through the membership
    // lease and COMMIT without resolving the same policy a second time.
    let current: Awaited<ReturnType<typeof lockCliRunPolicy>> | undefined
    return this.transaction(runId, actor.userId, async client => {
      const owned = await client.query('SELECT id FROM agent_runs WHERE id=$1 AND "deviceId"=$2',[runId,actor.deviceId])
      if (!owned.rowCount) throw new ApprovalUnavailable()
      current = await lockCliRunPolicy(client,runId,actor.userId)
      if (revision && current.revision !== revision) throw new ApprovalUnavailable()
      return current
    }, true, undefined, (_client,signal) => policyMemberships(current!,actor.userId,signal,this.membership))
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
      if (current.rows[0]?.status === 'paused') {
        const resumed = await client.query(`UPDATE agent_runs r SET status=COALESCE(r."resumeStatus",'running'),"resumeStatus"=NULL,"pauseReason"=NULL,"updatedAt"=now()
        FROM computer_run_bindings b JOIN bot_desktops d ON d."botId"=b."botId" AND d."ownerId"=b."ownerId" AND d."workspaceId"=b."workspaceId"
        WHERE r.id=$1 AND b."runId"=r.id AND b."ownerId"=r."userId" AND r.status='paused' AND r."pauseReason"='human_control'
          AND (d.control<>'user' OR d."controlUntil" IS NULL OR d."controlUntil"<=now()) RETURNING r.id`, [runId])
        if (resumed.rowCount) { await runListChanged(client, runId); await runChanged(client, runId) }
      }
      const row = current.rows[0]?.status === 'paused'
        ? await client.query('SELECT status FROM agent_runs WHERE id=$1 AND "deviceId"=$2', [runId, actor.deviceId])
        : current
      if (!row.rowCount) throw new ApprovalUnavailable()
      return { live: (await lockCliRunPolicy(client, runId, actor.userId)).revision === revision, paused: row.rows[0].status === 'paused' }
    }, true, {deviceId:actor.deviceId,revision})
  }
}
