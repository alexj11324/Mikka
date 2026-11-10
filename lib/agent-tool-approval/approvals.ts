import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { TOOL_APPROVAL_TTL_MS, toolApprovalEffectiveStatus, type ToolApprovalMethod, type ToolApprovalState, type ToolApprovalStatus } from '@mikka/protocol/tool-approval'
import { recordAudit } from '@/lib/audit/record'
import { RUN_APPROVAL_CHANNEL, notifyChannel } from '@/lib/db/listen'
import { toolApprovalsChanged } from '@/lib/live/tool-approvals'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { credentialMasker, maskDeep } from '@/lib/secrets/mask'
import { ApprovalUnavailable, type DeviceActor } from './store'
import { cliPolicyGuard, lockCliRunPolicy, realCliMembershipGuard, type CliMembershipGuard } from './policy-store'

/** One stored Ask request, as the owner's approval surface reads it. */
/** A pending (or decided) Ask request, without credentials or run tokens. */
export interface ToolApprovalView {
  approvalId: string
  runId: string
  status: ToolApprovalStatus
  method: ToolApprovalMethod
  tool: string
  /** Masked credential-shaped values; still task content, owner-only. */
  input: Record<string, unknown>
  createdAt: string
  expiresAt: string
}

interface ApprovalRow {
  id: string; runId: string; status: string; method: string; tool: string | null; input: unknown
  digest: string; inputDigest: string | null; policyRevision: string | null
  expiresAt: Date; createdAt: Date
}

const LIVE_STATUSES = ['preparing', 'running', 'waiting_input'] as const

function digestOf(parts: readonly unknown[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function stateOf(row: Pick<ApprovalRow, 'id' | 'status' | 'expiresAt'>, now = Date.now()): ToolApprovalState {
  return {
    approvalId: row.id,
    status: toolApprovalEffectiveStatus(row.status as ToolApprovalStatus, row.expiresAt.getTime(), now),
    expiresAt: row.expiresAt.getTime(),
  }
}

export class RunToolApprovalStore {
  constructor(private readonly pool: Pick<Pool, 'connect'>, private readonly membership: CliMembershipGuard = realCliMembershipGuard) {}

  /** The run must still be live and owned by the device; policy locks are
   * taken before the approval row, as every other run mutation does. */
  private async transaction<T>(runId: string, userId: string, work: (client: PoolClient) => Promise<T>, deviceId?: string): Promise<T> {
    return writeTransaction(this.pool, async client => {
      const { rowCount } = await client.query(
        `SELECT 1 FROM agent_runs WHERE id=$1 AND "userId"=$2 AND status=ANY($3::text[]) AND "stopRequestedAt" IS NULL AND "leaseExpiresAt">now()${deviceId ? ' AND "deviceId"=$4' : ''} FOR UPDATE`,
        deviceId ? [runId, userId, [...LIVE_STATUSES], deviceId] : [runId, userId, [...LIVE_STATUSES]])
      if (!rowCount) throw new ApprovalUnavailable()
      return work(client)
    }, { guard: cliPolicyGuard(runId, userId, this.membership) })
  }

  /** Store one exact request under the run's current mode and policy revision. */
  async request(actor: DeviceActor, runId: string, input: {
    policyRevision: string; requestId: string; harness: string; method: ToolApprovalMethod; tool: string; input: Record<string, unknown>
  }): Promise<ToolApprovalState> {
    return this.transaction(runId, actor.userId, async client => {
      const current = await lockCliRunPolicy(client, runId, actor.userId)
      if (current.revision !== input.policyRevision) throw new ApprovalUnavailable('policy_changed')
      if (current.mode !== 'ask') throw new ApprovalUnavailable('mode_not_ask')
      const { rows: [run] } = await client.query<{ harness: string | null; readOnly: boolean }>(
        `SELECT coalesce(r."agentDefinition"->>'harness',a.harness) AS harness,coalesce((r."agentDefinition"->>'readOnly')::boolean,false) AS "readOnly"
         FROM agent_runs r JOIN agents a ON a.id=r."agentId" WHERE r.id=$1 AND r."userId"=$2 FOR SHARE`, [runId, actor.userId])
      if (!run || run.readOnly || run.harness !== input.harness) throw new ApprovalUnavailable('policy_changed')
      const masked = maskDeep(input.input, credentialMasker)
      // The stored digest is over the masked input; inputDigest identifies the
      // original. A repeated requestId with either changed is a different call.
      const digest = digestOf(['tool-approval-v1', runId, input.requestId, input.method, input.tool, masked])
      const inputDigest = digestOf([input.input])
      const expiresAt = new Date(Date.now() + TOOL_APPROVAL_TTL_MS)
      await client.query(`INSERT INTO agent_tool_approvals
        (id,"runId","userId","deviceId","requestId",harness,method,tool,input,digest,"inputDigest","policyRevision",status,"expiresAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13)
        ON CONFLICT ("runId","requestId") DO NOTHING`,
        [randomUUID(), runId, actor.userId, actor.deviceId, input.requestId, input.harness, input.method, input.tool,
          JSON.stringify(masked), digest, inputDigest, input.policyRevision, expiresAt])
      const { rows: [row] } = await client.query<ApprovalRow>(
        `SELECT id,"runId",status,method,tool,input,digest,"inputDigest","policyRevision","expiresAt","createdAt"
         FROM agent_tool_approvals WHERE "runId"=$1 AND "requestId"=$2 FOR UPDATE`, [runId, input.requestId])
      if (!row || row.digest !== digest || row.inputDigest !== inputDigest || row.policyRevision !== input.policyRevision) throw new ApprovalUnavailable('policy_changed')
      await toolApprovalsChanged(client, actor.userId)
      return stateOf(row)
    }, actor.deviceId)
  }

  /** Read one request this device created; never mints or extends it. The run
   * must still be live: an ended or stopped run cannot consume its approval. */
  async state(actor: DeviceActor, runId: string, approvalId: string): Promise<ToolApprovalState> {
    const { rows: [row] } = await this.query<ApprovalRow>(
      `SELECT a.id,a."runId",a.status,a.method,a.tool,a.input,a.digest,a."inputDigest",a."policyRevision",a."expiresAt",a."createdAt"
       FROM agent_tool_approvals a JOIN agent_runs r ON r.id=a."runId" AND r."userId"=$3
       WHERE a.id=$1 AND a."runId"=$2 AND a."userId"=$3 AND a."deviceId"=$4
         AND r.status=ANY($5::text[]) AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now()`,
      [approvalId, runId, actor.userId, actor.deviceId, [...LIVE_STATUSES]])
    if (!row) throw new ApprovalUnavailable()
    return stateOf(row)
  }

  private async query<T extends QueryResultRow>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
    const client = await this.pool.connect()
    try { return await client.query<T>(sql, params as unknown[]) } finally { client.release() }
  }

  /** The person decided. Only the owner; a changed mode/policy or an expired
   * request is refused, so an old card cannot authorize the new thread. */
  async decide(userId: string, runId: string, approvalId: string, decision: 'approve' | 'deny', actorName?: string): Promise<ToolApprovalState> {
    return this.transaction(runId, userId, async client => {
      // Same lock order as a request: run -> policy -> approval row.
      const current = await lockCliRunPolicy(client, runId, userId)
      const { rows: [row] } = await client.query<ApprovalRow>(
        `SELECT id,"runId",status,method,tool,input,digest,"inputDigest","policyRevision","expiresAt","createdAt"
         FROM agent_tool_approvals WHERE id=$1 AND "runId"=$2 AND "userId"=$3 FOR UPDATE`, [approvalId, runId, userId])
      if (!row) throw new ApprovalUnavailable()
      const desired = decision === 'approve' ? 'approved' : 'denied'
      if (row.status !== 'pending') {
        if (row.status === desired) return stateOf(row)
        throw new ApprovalUnavailable('not_pending')
      }
      if (current.mode !== 'ask') throw new ApprovalUnavailable('mode_not_ask')
      if (current.revision !== row.policyRevision) throw new ApprovalUnavailable('policy_changed')
      if (row.expiresAt.getTime() <= Date.now()) {
        await client.query(`UPDATE agent_tool_approvals SET status='expired',"decidedAt"=coalesce("decidedAt",now()) WHERE id=$1 AND status='pending'`, [approvalId])
        throw new ApprovalUnavailable('expired')
      }
      if (!current.workspaceId) throw new ApprovalUnavailable('policy_changed')
      await client.query(`UPDATE agent_tool_approvals SET status=$2,"decidedAt"=now(),"decidedBy"=$3 WHERE id=$1 AND status='pending'`, [approvalId, desired, userId])
      await recordAudit(drizzle(client), {
        workspaceId: current.workspaceId,
        actor: { type: 'user', id: userId, name: actorName ?? userId },
        action: 'agent.approval_decided',
        target: { type: 'run', id: runId, label: row.tool ?? row.method },
        metadata: { runId, decision: desired, revision: current.revision },
      })
      await notifyChannel(client, RUN_APPROVAL_CHANNEL, [approvalId])
      await toolApprovalsChanged(client, userId)
      return { ...stateOf(row), status: desired as ToolApprovalStatus }
    })
  }

  /** The daemon acted on an approved request exactly once. */
  async consume(actor: DeviceActor, runId: string, approvalId: string): Promise<ToolApprovalState> {
    return this.transaction(runId, actor.userId, async client => {
      // Same lock order as a request: run -> policy -> approval row.
      const current = await lockCliRunPolicy(client, runId, actor.userId)
      const { rows: [row] } = await client.query<ApprovalRow>(
        `SELECT id,"runId",status,method,tool,input,digest,"inputDigest","policyRevision","expiresAt","createdAt"
         FROM agent_tool_approvals WHERE id=$1 AND "runId"=$2 AND "userId"=$3 AND "deviceId"=$4 FOR UPDATE`,
        [approvalId, runId, actor.userId, actor.deviceId])
      if (!row) throw new ApprovalUnavailable()
      if (row.status !== 'approved') return stateOf(row)
      if (current.mode !== 'ask') throw new ApprovalUnavailable('mode_not_ask')
      if (current.revision !== row.policyRevision) throw new ApprovalUnavailable('policy_changed')
      if (!current.workspaceId) throw new ApprovalUnavailable('policy_changed')
      await client.query(`UPDATE agent_tool_approvals SET status='consumed',"decidedAt"=coalesce("decidedAt",now()) WHERE id=$1 AND status='approved'`, [approvalId])
      await recordAudit(drizzle(client), {
        workspaceId: current.workspaceId,
        actor: { type: 'system', id: actor.deviceId, name: 'Mikka daemon' },
        action: 'agent.approval_consumed',
        target: { type: 'run', id: runId, label: row.tool ?? row.method },
        metadata: { runId, revision: current.revision },
      })
      return { ...stateOf(row), status: 'consumed' as ToolApprovalStatus }
    }, actor.deviceId)
  }

  /** The owner's approval surface: requests for one run, newest first. An
   * Ask request is run-bound and one-shot, so a run that ended or stopped
   * keeps no waiting cards; its approvals disappear with its authority. */
  async list(userId: string, runId: string): Promise<ToolApprovalView[]> {
    const { rows } = await this.query<ApprovalRow & { runId: string }>(
      `SELECT a.id,a."runId",a.status,a.method,a.tool,a.input,a.digest,a."inputDigest",a."policyRevision",a."expiresAt",a."createdAt"
       FROM agent_tool_approvals a JOIN agent_runs r ON r.id=a."runId" AND r."userId"=a."userId"
       WHERE a."runId"=$1 AND a."userId"=$2 AND a.status IN ('pending','approved','denied')
         AND r.status=ANY($3::text[]) AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">now()
       ORDER BY a."createdAt" DESC LIMIT 50`, [runId, userId, [...LIVE_STATUSES]])
    return rows.map(row => ({
      approvalId: row.id, runId: row.runId, status: toolApprovalEffectiveStatus(row.status as ToolApprovalStatus, row.expiresAt.getTime()),
      method: row.method as ToolApprovalMethod, tool: row.tool ?? row.method,
      input: (row.input && typeof row.input === 'object' ? row.input : {}) as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    }))
  }
}
