import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { workspacePool } from '@/lib/workspace-db'

type Query = Pick<Pool | PoolClient, 'query'>

/**
 * Fallback for a team left with one person (decision 2026-11-02-1500 item 4):
 * its only active member when nobody else is in it or invited to it, else
 * null. A team exists once an invitation is sent; it can still end up with
 * one person (everyone else left and no invitation is waiting). Then that
 * person's own credits pay for it without the sharing switch. An invitation
 * that is pending and not expired counts as someone; suspended members do
 * not. A personal workspace has one member and no invitations. This is the
 * one check for it; nothing in the product names it, and it does not decide
 * whether sharing switches show (they show in every team).
 */
export async function workspaceSoloMember(workspaceId: string, query: Query = workspacePool): Promise<string | null> {
  const { rows } = await query.query<{ userId: string }>(
    `SELECT m."userId" FROM mikka_workspace_members m
      WHERE m."workspaceId"=$1 AND m.status='active'
        AND NOT EXISTS (SELECT 1 FROM mikka_workspace_invitations i WHERE i."workspaceId"=$1 AND i.status='pending' AND i."expiresAt">now())
      LIMIT 2`, [workspaceId])
  return rows.length === 1 ? rows[0].userId : null
}

/** The person's own resources pay for this workspace without a share switch (the fallback above). */
export async function ownResourcesUsableWithoutShare(workspaceId: string, userId: string, query: Query = workspacePool): Promise<boolean> {
  return await workspaceSoloMember(workspaceId, query) === userId
}
