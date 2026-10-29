import type { PoolClient } from 'pg'
import { MailboxError } from './mailbox-error'
import type { WorkerDefinitionSnapshot } from './agent-kit/worker'
import { personalWorkerMailboxScopeMatches } from './personal-mailbox-capability'
import { mailboxGrantTools } from './personal-mailbox-grant'
import type { MailboxToolName } from '@mikka/protocol/mailbox'
import type { MailboxTransactionLease } from './mailbox-transaction-guard'

/** Host-derived scope, never part of tool schemas or mailbox envelopes. */
export interface PersonalNativeScope { holder: string; turnId: string; callId: string }
export type MailboxFence = (client: PoolClient, lease?: MailboxTransactionLease) => Promise<void>

/** Pin the namespace read by the HTTP resolver. Parent locks precede mailbox
 * and run locks so Bot/device revocation cannot race namespace admission.
 * The run row is re-read after waits and before COMMIT; replacing its Bot or
 * device never silently moves this request into a different namespace. */
export function workerMailboxFence(identity: {
  userId: string; runId: string; botId: string | null; deviceId: string; agentId: string; workspaceId: string; tokenHash: string; snapshot: WorkerDefinitionSnapshot; tool: MailboxToolName
}, enabled: () => boolean): MailboxFence {
  return async client => {
    if (!enabled()) throw new MailboxError('personal_mailbox_unavailable', 503)
    const denied = () => new MailboxError('Worker mailbox scope is no longer authorized', 403)
    if (!personalWorkerMailboxScopeMatches(identity.snapshot.harness, identity.snapshot, identity)) throw denied()
    if (identity.botId && !(await client.query('SELECT id FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR SHARE', [identity.botId, identity.userId, identity.workspaceId])).rowCount) throw denied()
    if (!(await client.query('SELECT id FROM devices WHERE id=$1 AND "ownerId"=$2 AND enabled FOR SHARE', [identity.deviceId, identity.userId])).rowCount) throw denied()
    if (!(await client.query('SELECT id FROM agents WHERE id=$1 AND "userId"=$2 FOR SHARE', [identity.agentId, identity.userId])).rowCount) throw denied()
    const { rowCount } = await client.query(`SELECT r.id FROM agent_runs r
      WHERE r.id=$1 AND r."userId"=$2 AND r."botId" IS NOT DISTINCT FROM $3::uuid AND r."deviceId"=$4 AND r."agentId"=$6
        AND r.kind<>'group_review' AND r.status IN ('queued','preparing','running','waiting_input','finishing')
        AND to_jsonb(r)->'agentDefinition'=$7::jsonb
        AND EXISTS (SELECT 1 FROM agents a WHERE a.id=r."agentId" AND a."userId"=r."userId")
        AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">clock_timestamp()
        AND EXISTS (SELECT 1 FROM run_tokens t WHERE t."runId"=r.id AND t."userId"=r."userId"
          AND t."tokenHash"=$5 AND t."revokedAt" IS NULL AND t."expiresAt">clock_timestamp())`,
    [identity.runId, identity.userId, identity.botId, identity.deviceId, identity.tokenHash, identity.agentId, JSON.stringify(identity.snapshot)])
    if (!rowCount) throw denied()
    const tools = await mailboxGrantTools(client, { ...identity, executionId: identity.snapshot.parent!.executionId, worker: identity.snapshot }, true)
    if (!tools.includes(identity.tool)) throw new MailboxError('Mailbox tool grant revoked', 403)
  }
}

/** Admission and precommit checks use the SAME transaction client. Ordered
 * SHARE locks retain authority against close/revoke/lease replacement until
 * commit; the final fresh clock check also catches expiry during mailbox waits.
 * The optional Bot is locked first, matching its FK deletion cascade direction.
 * No scheduler, runtime selection or native lifecycle writer is changed. */
export function nativeMailboxFence(identity: {
  userId: string; botId: string | null; workspaceId: string; scope: PersonalNativeScope; action: string; toolName?: string
}, enabled: () => boolean): MailboxFence {
  return async client => {
    const denied = () => new MailboxError('Native mailbox authority expired or revoked', 409)
    if (!enabled()) throw new MailboxError('personal_mailbox_unavailable', 503)
    if (identity.botId && !(await client.query('SELECT id FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR SHARE', [identity.botId, identity.userId, identity.workspaceId])).rows.length) throw denied()
    // Device is the turn's FK parent (deletion is D -> J). Read only an
    // identity hint, lock D first, then require J still points to that D.
    // Never acquire a replacement device after locking the turn.
    const { rows: [hint] } = await client.query<{ deviceId: string }>(`SELECT "deviceId" FROM native_coordinator_turns
      WHERE id=$1 AND "userId"=$2 AND holder=$3 AND status='running'`, [identity.scope.turnId, identity.userId, identity.scope.holder])
    if (!hint) throw denied()
    if (!(await client.query('SELECT id FROM devices WHERE id=$1 AND "ownerId"=$2 AND enabled FOR SHARE', [hint.deviceId, identity.userId])).rows.length) throw denied()
    if (!(await client.query(`SELECT "deviceId" FROM native_coordinator_turns WHERE id=$1
      AND "userId"=$2 AND holder=$3 AND "deviceId"=$4 AND status='running' FOR SHARE`,
    [identity.scope.turnId, identity.userId, identity.scope.holder, hint.deviceId])).rows.length) throw denied()
    if (!(await client.query(`SELECT 1 FROM coordinator_sessions WHERE "userId"=$1
      AND "botId" IS NOT DISTINCT FROM $2::uuid AND "leaseHolder"=$3 FOR SHARE`, [identity.userId, identity.botId, identity.scope.holder])).rows.length) throw denied()
    if (!(await client.query(`SELECT 1 FROM native_coordinator_tools WHERE "turnId"=$1
      AND "callId"=$2 AND name=$3 AND status='pending' FOR SHARE`, [identity.scope.turnId, identity.scope.callId, (identity.toolName ?? `mailbox_${identity.action}`)])).rows.length) throw denied()
    // New statement after ALL row-lock waits: clock_timestamp, not the BEGIN
    // timestamp, is the authorization linearization point for expiring leases.
    const { rows } = await client.query(`SELECT 1 FROM native_coordinator_turns j
      JOIN coordinator_sessions s ON s."userId"=j."userId"
      JOIN devices d ON d.id=j."deviceId"
      JOIN native_coordinator_tools t ON t."turnId"=j.id
      WHERE j.id=$1 AND j."userId"=$2 AND j.holder=$3 AND j.status='running'
        AND s."botId" IS NOT DISTINCT FROM $5::uuid AND s."leaseHolder"=j.holder
        AND s."leaseUntil">clock_timestamp() AND j."expiresAt">clock_timestamp()
        AND d."ownerId"=j."userId" AND d.enabled
        AND t."callId"=$4 AND t.name=$6 AND t.status='pending'`, [identity.scope.turnId, identity.userId,
      identity.scope.holder, identity.scope.callId, identity.botId, (identity.toolName ?? `mailbox_${identity.action}`)])
    if (!rows.length) throw denied()
  }
}
