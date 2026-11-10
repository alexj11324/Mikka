import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { runChanged } from './live/panels'
import { runListChanged } from './live/lists'
import { runControlChanged } from './device-gateway-notify'
import { armDueTimerAfterCommit } from './due-timer'
import { readBatchSubscriptionPolicy } from './desktop-rpc/read-batch-context'
import { organizationResourceAllowed, workspaceResourcePolicy, assertOrganizationResourceShare } from './governance/resource-access'

/**
 * Decision 2026-11-01-2240: a person's own subscriptions and API keys always run
 * that person's own bots and runs, in every workspace they belong to. No share
 * row and no admin switch limits it. What a share row and the admin switch
 * decide is whether OTHER members' bots may use it there: 分享给团队成员
 * (`allowOthers`), and only while the admin leaves 团队权限 › 订阅与 API Key on 允许.
 */
type Query = Pick<Pool | PoolClient, 'query'>

/** The admin switch over other members' use; an absent row means on. It never limits the owner's own use. */
export async function memberSubscriptionsAllowed(query: Query, workspaceId: string): Promise<boolean> {
  if ((await workspaceResourcePolicy(workspaceId)).modelCredentialSharing === 'deny') return false
  return readBatchSubscriptionPolicy(query, workspaceId, async () => {
    const { rows: [row] } = await query.query<{ subscriptions: boolean }>('SELECT subscriptions FROM workspace_personal_policies WHERE "workspaceId"=$1', [workspaceId])
    return row?.subscriptions ?? true
  })
}

/** 分享给团队成员: the owner also lets other members' bots here use it (Alex, 「B」). */
export async function othersMayUse(query: Query, ownerId: string, workspaceId: string): Promise<boolean> {
  const { rows: [row] } = await query.query<{ allowOthers: boolean }>(`SELECT CASE WHEN sh."allowOthers" THEN NOT EXISTS (
    SELECT 1 FROM workspace_personal_policies p WHERE p."workspaceId"=$2 AND NOT p.subscriptions
  ) ELSE false END AS "allowOthers" FROM workspace_subscription_shares sh
    WHERE sh."ownerId"=$1 AND sh."workspaceId"=$2`, [ownerId, workspaceId])
  return Boolean(row?.allowOthers) && await organizationResourceAllowed(workspaceId, 'subscription', ownerId, ownerId)
}

/**
 * Members who shared their subscriptions here for other members too, oldest
 * share first: the deterministic order a bot without its own subscription uses.
 */
export async function pooledOwners(query: Query, runOwnerId: string, workspaceId: string): Promise<string[]> {
  const owners = (await query.query<{ ownerId: string }>('SELECT "ownerId" FROM workspace_subscription_shares WHERE "workspaceId"=$1 AND "allowOthers" AND "ownerId"<>$2 ORDER BY "createdAt","ownerId"', [workspaceId, runOwnerId])).rows.map(row => row.ownerId)
  // No borrowed source means no sharing decision. Actual lenders still pass
  // the current Workspace policy and each Organization approval below.
  if (!owners.length || !(await memberSubscriptionsAllowed(query, workspaceId))) return []
  const allowed = await Promise.all(owners.map(ownerId => organizationResourceAllowed(workspaceId, 'subscription', ownerId, ownerId)))
  return owners.filter((_, index) => allowed[index])
}

/**
 * The owner's own choice; the caller has checked membership. `allowOthers` is left as it is when omitted.
 * Un-sharing stops only other members' runs on the owner's subscriptions; the owner's own runs go on
 * (decision 2026-11-01-2240).
 */
export async function setSubscriptionShare(query: Query, ownerId: string, workspaceId: string, shared: boolean, allowOthers?: boolean) {
  if (!shared) {
    await query.query('DELETE FROM workspace_subscription_shares WHERE "ownerId"=$1 AND "workspaceId"=$2', [ownerId, workspaceId])
    await stopRunsUsingSubscriptions(query, { ownerId, workspaceId, othersOnly: true })
    return
  }
  if (allowOthers === true) await assertOrganizationResourceShare(workspaceId, 'subscription', ownerId, ownerId)
  await query.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId","allowOthers") VALUES ($1,$2,COALESCE($3::boolean,false))
    ON CONFLICT ("ownerId","workspaceId") DO UPDATE SET "allowOthers"=COALESCE($3::boolean,workspace_subscription_shares."allowOthers")`, [ownerId, workspaceId, allowOthers ?? null])
  if (allowOthers === false) await stopRunsUsingSubscriptions(query, { ownerId, workspaceId, othersOnly: true })
}

/**
 * Withdrawing a credential stops the runs using it now: disconnecting or leaving
 * stops all of them; un-sharing, 分享给团队成员 off and the admin switch off stop
 * only other members' runs (`othersOnly`). It goes through the usual
 * stop request and lease cut: the device's daemon ends the run and deletes the
 * short-lived credential it was given, and every credential access or renewal
 * already refuses a run with a stop request. The running CLI is stopped through
 * its control channel; provider and tool calls add no authorization round trip.
 * At least a workspace or a connection, so it can never stop everything.
 * Returns how many runs it newly stopped.
 */
export async function stopRunsUsingSubscriptions(query: Query, scope: { ownerId?: string; workspaceId?: string; connectionId?: string; othersOnly?: boolean }) {
  if (!scope.workspaceId && !scope.connectionId) throw new Error('stopRunsUsingSubscriptions needs a workspace or a connection')
  const { rowCount, rows } = await query.query<{ id: string }>(`UPDATE agent_runs r SET "stopRequestedAt"=clock_timestamp(),
      "leaseExpiresAt"=LEAST(r."leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
    FROM byos_native_runs n JOIN byos_bindings b ON b.id=n."bindingId" JOIN byos_connections c ON c.id=b."connectionId"
    WHERE n."runId"=r.id AND r."stopRequestedAt" IS NULL AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing')
      AND ($1::text IS NULL OR c."ownerId"=$1) AND ($2::text IS NULL OR b."workspaceId"::text=$2)
      AND ($3::uuid IS NULL OR c.id=$3) AND (NOT $4::boolean OR r."userId"<>c."ownerId") RETURNING r.id`,
    [scope.ownerId ?? null, scope.workspaceId ?? null, scope.connectionId ?? null, scope.othersOnly ?? false])
  for (const { id } of rows) { await runListChanged(query, id); await runChanged(query, id) }
  runControlChanged(query, { runIds: rows.map(row => row.id) })
  if (rows.length) armDueTimerAfterCommit(query, 'run-recovery')
  return rowCount ?? 0
}

/**
 * SQL for 分享给团队成员 on a run (orchestration.md §2, §6): may the credential
 * owner's subscription serve the run owner's run in this workspace? Yes for the
 * owner themselves; for another member only while the owner shares it there for
 * others too and the admin allows member subscriptions. Membership lives in the
 * workspace database, so callers check it there (authorizeSubscriptionWorkspace);
 * leaving also stops the runs (releaseDepartingMember). Checked on every lease
 * and credential read, so withdrawing stops the next one.
 */
export const runMayUseCredentialSql = (credentialOwner: string, runOwner: string, workspace: string) =>
  `(${credentialOwner}=${runOwner} OR (
    EXISTS (SELECT 1 FROM workspace_subscription_shares sh WHERE sh."ownerId"=${credentialOwner} AND sh."allowOthers" AND sh."workspaceId"::text=(${workspace})::text)
    AND NOT EXISTS (SELECT 1 FROM workspace_personal_policies pp WHERE pp."workspaceId"::text=(${workspace})::text AND NOT pp.subscriptions)))`

/**
 * A device run whose owner has no subscription of their own here: bind the
 * first member's subscription shared with 分享给团队成员 to this run's agent
 * (the owner keeps the binding; it names the connection, never a credential).
 * Returns the binding id, or null when nobody shares one for this harness.
 */
export async function sharedNativeBinding(query: Query, runOwnerId: string, agentId: string, harness: string, workspaceId: string): Promise<string | null> {
  if (harness !== 'codex' && harness !== 'claude_code') return null
  const provider = harness === 'codex' ? 'codex' : 'claude'
  const route = harness === 'codex' ? 'codex_cli' : 'claude_code_cli'
  for (const ownerId of await pooledOwners(query, runOwnerId, workspaceId)) {
    const { rows: [template] } = await query.query<{ connectionId: string; epoch: string; modelId: string }>(
      `SELECT b."connectionId",c.epoch,b."modelId" FROM byos_bindings b
        JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId" AND c.state='connected' AND c.paused=false AND c.epoch=b."connectionRevision" AND c.provider=$3
        WHERE b."ownerId"=$1 AND b."workspaceId"=$2 AND ${runMayUseCredentialSql('$1', '$4', '$2')}
        ORDER BY (b.route=$5) DESC, b."createdAt" DESC, b.id DESC LIMIT 1`,
      [ownerId, workspaceId, provider, runOwnerId, route])
    if (!template) continue
    const hash = createHash('sha256').update(JSON.stringify([ownerId, workspaceId, agentId, template.connectionId, String(template.epoch)])).digest('hex')
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
    await query.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`, [id, ownerId, workspaceId, agentId, template.connectionId, template.epoch, route, template.modelId])
    return id
  }
  return null
}
