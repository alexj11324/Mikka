import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { workspacePool } from '@/lib/workspace-db'

type Query = Pick<Pool | PoolClient, 'query'>

/**
 * Fallback for a team left with one member (decision 2026-11-02-1500 item 4):
 * its only active member, else null. A team starts with two people; it can
 * still end up with one (a team from before that decision, or the others
 * left). Until someone else joins, that member's own credits pay for it
 * without the sharing switch. Pending invitations and suspended members do
 * not count. A personal workspace also has one member. This is the one check
 * for it; nothing in the product names it.
 */
export async function workspaceSoloMember(workspaceId: string, query: Query = workspacePool): Promise<string | null> {
  const { rows } = await query.query<{ userId: string }>(
    `SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND status='active' LIMIT 2`, [workspaceId])
  return rows.length === 1 ? rows[0].userId : null
}

/** The person's own resources pay for this workspace without a share switch (the fallback above). */
export async function ownResourcesUsableWithoutShare(workspaceId: string, userId: string, query: Query = workspacePool): Promise<boolean> {
  return await workspaceSoloMember(workspaceId, query) === userId
}
