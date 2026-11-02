import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { workspacePool } from '@/lib/workspace-db'

type Query = Pick<Pool | PoolClient, 'query'>

/**
 * A workspace with one person in it (decision 2026-11-02-1500): its only
 * active member, else null. A personal workspace always has one; a team has
 * one until a second member joins. Pending invitations and suspended members
 * do not count. While a workspace has one member, everything that person owns
 * is usable there without a sharing switch (credits, subscriptions, API keys,
 * computers); once a second member joins, the switches and permissions apply.
 * Every "share with the team" decision asks this one function.
 */
export async function workspaceSoloMember(workspaceId: string, query: Query = workspacePool): Promise<string | null> {
  const { rows } = await query.query<{ userId: string }>(
    `SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND status='active' LIMIT 2`, [workspaceId])
  return rows.length === 1 ? rows[0].userId : null
}

/** The person's own resources pay and run in this workspace without a share switch. */
export async function ownResourcesUsableWithoutShare(workspaceId: string, userId: string, query: Query = workspacePool): Promise<boolean> {
  return await workspaceSoloMember(workspaceId, query) === userId
}
