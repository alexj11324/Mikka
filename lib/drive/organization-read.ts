import 'server-only'
import { pool } from '@/lib/db'
import { requireEnterpriseOrganization } from '@/lib/enterprise/access'
import { GovernanceError } from '@/lib/governance/errors'
import { workspaceDb, workspacePool } from '@/lib/workspace-db'
import type { PoolClient } from 'pg'

export type OrganizationDriveProject = { id: string; workspaceId: string }

/** The Workspace database owns memberships, attachment and Project lifecycle.
 * APP owns link metadata and content ACLs. Hold canonical rows until the
 * authorization and pagination query has finished in APP. */
export async function withOrganizationDriveRead<T>(organizationId: string, reader: string, sessionId: string,
  findProjects: (workspaces: string[], reader: string) => Promise<OrganizationDriveProject[]>,
  read: (app: PoolClient, workspaces: string[], projects: OrganizationDriveProject[]) => Promise<T>) {
  return workspaceDb.transaction(async () => {
    // Detach and member removal lock Workspaces in UUID order before the
    // organization. A later statement sees the current attachment after waits.
    const { rows: candidates } = await workspacePool.query<{ id: string }>(`SELECT w.id FROM mikka_workspaces w
      JOIN mikka_organization_workspaces a ON a."workspaceId"=w.id
      JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=$2 AND m.status='active'
      JOIN mikka_organization_members o ON o."organizationId"=a."organizationId" AND o."userId"=$2 AND o.status='active'
      WHERE a."organizationId"=$1 AND w.kind='team' ORDER BY w.id FOR SHARE OF w`, [organizationId, reader])
    const membership = await workspacePool.query(`SELECT 1 FROM mikka_organizations o
      JOIN mikka_organization_members m ON m."organizationId"=o.id
      WHERE o.id=$1 AND o."archivedAt" IS NULL AND m."userId"=$2 AND m.status='active'
      FOR SHARE OF o,m`, [organizationId, reader])
    if (!membership.rowCount) throw new GovernanceError('access_denied')
    const { rows: attached } = await workspacePool.query<{ id: string }>(`SELECT a."workspaceId" AS id
      FROM mikka_organization_workspaces a JOIN mikka_workspace_members m ON m."workspaceId"=a."workspaceId"
      WHERE a."workspaceId"=ANY($1::uuid[]) AND a."organizationId"=$2 AND m."userId"=$3 AND m.status='active'
      ORDER BY a."workspaceId" FOR SHARE OF m,a`, [candidates.map(row => row.id), organizationId, reader])
    const workspaceIds = attached.map(row => row.id)
    // These initial IDs only narrow the canonical locks. The final APP query
    // below checks live visibility and the original ACL before counting.
    const projects = await findProjects(workspaceIds, reader)
    const { rows: active } = await workspacePool.query<OrganizationDriveProject>(`SELECT p.id,p."workspaceId" FROM workspace_projects p
      JOIN unnest($1::uuid[],$2::uuid[]) c(id,workspace_id) ON c.id=p.id AND c.workspace_id=p."workspaceId"
      WHERE p."archivedAt" IS NULL ORDER BY p."workspaceId",p.id FOR SHARE OF p`,
    [projects.map(project => project.id), projects.map(project => project.workspaceId)])

    // One read-only snapshot orders enterprise revocation, original Drive and
    // Project ACLs, page count, and rows while canonical membership is pinned.
    const app = await pool.connect()
    try {
      await app.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await requireEnterpriseOrganization(reader, organizationId, sessionId, app)
      const result = await read(app, workspaceIds, active)
      await app.query('COMMIT')
      return result
    } catch (error) {
      await app.query('ROLLBACK')
      throw error
    } finally { app.release() }
  })
}
