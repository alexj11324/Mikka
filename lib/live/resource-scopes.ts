import type { PoolClient } from 'pg'
import type { ResourceKind } from '../resource-access/contract'
import type { LiveScope } from './scope'

type Database = Pick<PoolClient, 'query'>

/** A list/count invalidation is observable activity too. Resolve active
 * tenants first and filter recipients using the same content ACL as reads. */
export async function resourceLiveScopes(database: Database, workspaceDatabase: Database,
  kind: ResourceKind, id: string, workspaceId: string | null, viewerId: string | null = null): Promise<LiveScope[]> {
  if (!workspaceId) return []
  const { rows: members } = await workspaceDatabase.query<LiveScope>(
    `SELECT m."userId" AS "ownerId",w.id AS "workspaceId" FROM mikka_workspaces w
     JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m.status='active'
     WHERE w.id=$1 AND (w.kind='team' OR w."userId"=m."userId")
       AND ($2::text IS NULL OR m."userId"=$2)`, [workspaceId, viewerId])
  if (!members.length) return []
  const { rows } = await database.query<LiveScope>(
    `SELECT s."ownerId",s."workspaceId" FROM jsonb_to_recordset($1::jsonb) s("ownerId" text,"workspaceId" uuid)
     WHERE mikka_resource_acl_allowed('account',s."ownerId",s."workspaceId",$2,$3::uuid,'canReadContent')`,
    [JSON.stringify(members), kind, id])
  return rows
}
