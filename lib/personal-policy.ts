import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { stopRunsUsingApiKeys } from './model-api-key-runs'

/**
 * Decision 2026-10-31-2225: a subscription belongs to its owner. Their personal
 * workspace uses it automatically; a team workspace uses it only after the owner
 * shares it there (在这里使用我的订阅), for the owner's own bots and, if they also
 * turn on 分享给团队成员, other members' bots; and only while that workspace's
 * admin leaves 允许成员使用个人订阅 on (the default).
 */
type Query = Pick<Pool | PoolClient, 'query'>

/** The admin switch; an absent row means on. */
export async function memberSubscriptionsAllowed(query: Query, workspaceId: string): Promise<boolean> {
  const { rows: [row] } = await query.query<{ subscriptions: boolean }>('SELECT subscriptions FROM workspace_personal_policies WHERE "workspaceId"=$1', [workspaceId])
  return row?.subscriptions ?? true
}

/** Whether the owner shared their subscriptions into this workspace. */
export async function subscriptionShared(query: Query, ownerId: string, workspaceId: string): Promise<boolean> {
  return Boolean((await query.query('SELECT 1 FROM workspace_subscription_shares WHERE "ownerId"=$1 AND "workspaceId"=$2', [ownerId, workspaceId])).rowCount)
}

/** 分享给团队成员: the owner also lets other members' bots here use it (Alex, 「B」). */
export async function othersMayUse(query: Query, ownerId: string, workspaceId: string): Promise<boolean> {
  const { rows: [row] } = await query.query<{ allowOthers: boolean }>('SELECT "allowOthers" FROM workspace_subscription_shares WHERE "ownerId"=$1 AND "workspaceId"=$2', [ownerId, workspaceId])
  return Boolean(row?.allowOthers) && (await memberSubscriptionsAllowed(query, workspaceId))
}

/**
 * Members who shared their subscriptions here for other members too, oldest
 * share first: the deterministic order a bot without its own subscription uses.
 */
export async function pooledOwners(query: Query, runOwnerId: string, workspaceId: string): Promise<string[]> {
  if (!(await memberSubscriptionsAllowed(query, workspaceId))) return []
  return (await query.query<{ ownerId: string }>('SELECT "ownerId" FROM workspace_subscription_shares WHERE "workspaceId"=$1 AND "allowOthers" AND "ownerId"<>$2 ORDER BY "createdAt","ownerId"', [workspaceId, runOwnerId])).rows.map(row => row.ownerId)
}

/** May the owner's own subscriptions run their bots in this workspace? */
export async function subscriptionsUsable(query: Query, ownerId: string, workspaceId: string): Promise<boolean> {
  return (await subscriptionShared(query, ownerId, workspaceId)) && (await memberSubscriptionsAllowed(query, workspaceId))
}

/** The owner's own choice; the caller has checked membership. `allowOthers` is left as it is when omitted. */
export async function setSubscriptionShare(query: Query, ownerId: string, workspaceId: string, shared: boolean, allowOthers?: boolean) {
  if (!shared) {
    await query.query('DELETE FROM workspace_subscription_shares WHERE "ownerId"=$1 AND "workspaceId"=$2', [ownerId, workspaceId])
    await stopRunsUsingSubscriptions(query, { ownerId, workspaceId })
    await stopRunsUsingApiKeys(query, { ownerId, workspaceId })
    return
  }
  await query.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId","allowOthers") VALUES ($1,$2,COALESCE($3::boolean,false))
    ON CONFLICT ("ownerId","workspaceId") DO UPDATE SET "allowOthers"=COALESCE($3::boolean,workspace_subscription_shares."allowOthers")`, [ownerId, workspaceId, allowOthers ?? null])
  if (allowOthers === false) await stopRunsUsingSubscriptions(query, { ownerId, workspaceId, othersOnly: true })
}

/**
 * Withdrawing a credential (un-sharing, 分享给团队成员 off, leaving, the admin
 * switch off, disconnecting) stops the runs using it now, through the usual
 * stop request and lease cut: the device's daemon ends the run and deletes the
 * short-lived credential it was given, and every credential access or renewal
 * already refuses a run with a stop request. Model calls re-check on their own.
 * At least a workspace or a connection, so it can never stop everything.
 * Returns how many runs it newly stopped.
 */
export async function stopRunsUsingSubscriptions(query: Query, scope: { ownerId?: string; workspaceId?: string; connectionId?: string; othersOnly?: boolean }) {
  if (!scope.workspaceId && !scope.connectionId) throw new Error('stopRunsUsingSubscriptions needs a workspace or a connection')
  const { rowCount } = await query.query(`UPDATE agent_runs r SET "stopRequestedAt"=clock_timestamp(),
      "leaseExpiresAt"=LEAST(r."leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
    FROM byos_native_runs n JOIN byos_bindings b ON b.id=n."bindingId" JOIN byos_connections c ON c.id=b."connectionId"
    WHERE n."runId"=r.id AND r."stopRequestedAt" IS NULL AND r.status IN ('queued','preparing','running','waiting_input','finishing')
      AND ($1::text IS NULL OR c."ownerId"=$1) AND ($2::text IS NULL OR b."workspaceId"::text=$2)
      AND ($3::uuid IS NULL OR c.id=$3) AND (NOT $4::boolean OR r."userId"<>c."ownerId")`,
    [scope.ownerId ?? null, scope.workspaceId ?? null, scope.connectionId ?? null, scope.othersOnly ?? false])
  return rowCount ?? 0
}

/** SQL fragment for the same rule, with the owner and workspace as SQL expressions. */
export const subscriptionsUsableSql = (owner: string, workspace: string) =>
  `EXISTS (SELECT 1 FROM workspace_subscription_shares sh WHERE sh."ownerId"=${owner} AND sh."workspaceId"::text=(${workspace})::text)
   AND NOT EXISTS (SELECT 1 FROM workspace_personal_policies pp WHERE pp."workspaceId"::text=(${workspace})::text AND NOT pp.subscriptions)`

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
        JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId" AND c.state='connected' AND c.epoch=b."connectionRevision" AND c.provider=$3
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
