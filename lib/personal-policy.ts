import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'

/**
 * Decision 2026-10-31-2225: a subscription belongs to its owner. Their personal
 * workspace uses it automatically; a team workspace uses it only after the owner
 * shares it there (在这里使用我的订阅), only for the owner's own bots, and only
 * while that workspace's admin leaves 允许成员使用个人订阅 on (the default).
 */
type Query = Pick<Pool | PoolClient, 'query'>
export const sharedInput = z.boolean()

/** The admin switch; an absent row means on. */
export async function memberSubscriptionsAllowed(query: Query, workspaceId: string): Promise<boolean> {
  const { rows: [row] } = await query.query<{ subscriptions: boolean }>('SELECT subscriptions FROM workspace_personal_policies WHERE "workspaceId"=$1', [workspaceId])
  return row?.subscriptions ?? true
}

/** Whether the owner shared their subscriptions into this workspace. */
export async function subscriptionShared(query: Query, ownerId: string, workspaceId: string): Promise<boolean> {
  return Boolean((await query.query('SELECT 1 FROM workspace_subscription_shares WHERE "ownerId"=$1 AND "workspaceId"=$2', [ownerId, workspaceId])).rowCount)
}

/** May the owner's own subscriptions run their bots in this workspace? */
export async function subscriptionsUsable(query: Query, ownerId: string, workspaceId: string): Promise<boolean> {
  return (await subscriptionShared(query, ownerId, workspaceId)) && (await memberSubscriptionsAllowed(query, workspaceId))
}

/** The owner's own choice; the caller has checked membership. */
export async function setSubscriptionShare(query: Query, ownerId: string, workspaceId: string, shared: boolean) {
  if (shared) await query.query('INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2) ON CONFLICT DO NOTHING', [ownerId, workspaceId])
  else await query.query('DELETE FROM workspace_subscription_shares WHERE "ownerId"=$1 AND "workspaceId"=$2', [ownerId, workspaceId])
}

/** SQL fragment for the same rule, with the owner and workspace as SQL expressions. */
export const subscriptionsUsableSql = (owner: string, workspace: string) =>
  `EXISTS (SELECT 1 FROM workspace_subscription_shares sh WHERE sh."ownerId"=${owner} AND sh."workspaceId"::text=(${workspace})::text)
   AND NOT EXISTS (SELECT 1 FROM workspace_personal_policies pp WHERE pp."workspaceId"::text=(${workspace})::text AND NOT pp.subscriptions)`
