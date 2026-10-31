import type { Pool, PoolClient } from 'pg'

/**
 * Decision 2026-10-31-2225: a subscription belongs to its owner. Their personal
 * workspace uses it automatically; a team workspace uses it only after the owner
 * shares it there (在这里使用我的订阅), for the owner's own bots and, if they also
 * turn on 团队成员也可以用, other members' bots; and only while that workspace's
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

/** 团队成员也可以用: the owner also lets other members' bots here use it (Alex, 「B」). */
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
  if (!shared) return void await query.query('DELETE FROM workspace_subscription_shares WHERE "ownerId"=$1 AND "workspaceId"=$2', [ownerId, workspaceId])
  await query.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId","allowOthers") VALUES ($1,$2,COALESCE($3::boolean,false))
    ON CONFLICT ("ownerId","workspaceId") DO UPDATE SET "allowOthers"=COALESCE($3::boolean,workspace_subscription_shares."allowOthers")`, [ownerId, workspaceId, allowOthers ?? null])
}

/** SQL fragment for the same rule, with the owner and workspace as SQL expressions. */
export const subscriptionsUsableSql = (owner: string, workspace: string) =>
  `EXISTS (SELECT 1 FROM workspace_subscription_shares sh WHERE sh."ownerId"=${owner} AND sh."workspaceId"::text=(${workspace})::text)
   AND NOT EXISTS (SELECT 1 FROM workspace_personal_policies pp WHERE pp."workspaceId"::text=(${workspace})::text AND NOT pp.subscriptions)`
