import 'server-only'
import { pool } from '@/lib/db'
import { requireEnterpriseOrganization } from '@/lib/enterprise/access'
import { GovernanceError } from '@/lib/governance/errors'
import { workspaceDb, workspacePool } from '@/lib/workspace-db'
import { listReadableFileDirectory } from './file-links'

type Project = { id: string; workspaceId: string }

/** The Workspace database owns memberships, attachment and Project lifecycle.
 * APP owns link metadata and content ACLs. Hold canonical rows until the
 * authorization and pagination query has finished in APP. */
export async function listOrganizationFileLinks(organizationId: string, reader: string, sessionId: string, page: number) {
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
    const { rows: projects } = await pool.query<Project>(`SELECT DISTINCT p.id,p."workspaceId"
      FROM resource_access_policies p JOIN drive_volumes v ON v."workspaceId"=p."workspaceId" AND v."scopeId"=p.id::text
      JOIN drive_file_links l ON l."volumeId"=v.id
      WHERE p.kind='project' AND p."workspaceId"=ANY($1::uuid[]) AND v."archivedAt" IS NULL
        AND v."driveScope" IN ('project','project-user')
        AND (l."createdBy"=$2 OR l.visibility='org' AND v."driveScope"='project')
        AND mikka_resource_acl_allowed('account',$2,p."workspaceId",p.kind,p.id,'canReadContent')`, [workspaceIds, reader])
    const { rows: active } = await workspacePool.query<Project>(`SELECT p.id,p."workspaceId" FROM workspace_projects p
      JOIN unnest($1::uuid[],$2::uuid[]) c(id,workspace_id) ON c.id=p.id AND c.workspace_id=p."workspaceId"
      WHERE p."archivedAt" IS NULL ORDER BY p."workspaceId",p.id FOR SHARE OF p`,
    [projects.map(project => project.id), projects.map(project => project.workspaceId)])

    // One read-only snapshot orders enterprise revocation, original Drive and
    // Project ACLs, page count, and rows while canonical membership is pinned.
    const app = await pool.connect()
    try {
      await app.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await requireEnterpriseOrganization(reader, organizationId, sessionId, app)
      const result = await listReadableFileDirectory(app, workspaceIds, reader, active, { number: page, limit: 50 })
      await app.query('COMMIT')
      const items = result.links.map(({ workspaceId: _workspaceId, driveScope: _scope, volumeName: _name, ...item }) =>
        ({ ...item, automationId: null }))
      return { items, page: result.page, pageCount: result.pageCount, total: result.total }
    } catch (error) {
      await app.query('ROLLBACK')
      throw error
    } finally { app.release() }
  })
}
