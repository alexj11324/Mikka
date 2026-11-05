import type { PoolClient } from 'pg'
import type { LiveScope } from './scope'

type Database = Pick<PoolClient, 'query'>

/** Owner-wide reads use the owner's real personal workspace as their private
 * transport. This never creates a workspace, borrows a selected team, or grants
 * access to any content. The ordinary reader still authorizes every request. */
export async function ownerLiveScope(workspaceDatabase: Database, ownerId: string): Promise<LiveScope | null> {
  const { rows } = await workspaceDatabase.query<LiveScope>(
    `SELECT w."userId" AS "ownerId",w.id AS "workspaceId" FROM mikka_workspaces w
      JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=w."userId" AND m.status='active'
      WHERE w."userId"=$1 AND w.kind='personal'`, [ownerId],
  )
  return rows.length === 1 ? rows[0] : null
}
