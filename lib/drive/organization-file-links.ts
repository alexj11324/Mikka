import 'server-only'
import { pool } from '@/lib/db'
import { listReadableFileDirectory } from './file-links'
import { withOrganizationDriveRead, type OrganizationDriveProject } from './organization-read'

async function projectsWithShares(workspaceIds: string[], reader: string) {
  const { rows: projects } = await pool.query<OrganizationDriveProject>(`SELECT DISTINCT p.id,p."workspaceId"
      FROM resource_access_policies p JOIN drive_volumes v ON v."workspaceId"=p."workspaceId" AND v."scopeId"=p.id::text
      JOIN drive_file_links l ON l."volumeId"=v.id
      WHERE p.kind='project' AND p."workspaceId"=ANY($1::uuid[]) AND v."archivedAt" IS NULL
        AND v."driveScope" IN ('project','project-user')
        AND (l."createdBy"=$2 OR l.visibility='org' AND v."driveScope"='project')
        AND mikka_resource_acl_allowed('account',$2,p."workspaceId",p.kind,p.id,'canReadContent')`, [workspaceIds, reader])
  return projects
}

export function listOrganizationFileLinks(organizationId: string, reader: string, sessionId: string, page: number) {
  return withOrganizationDriveRead(organizationId, reader, sessionId, projectsWithShares, async (app, workspaces, projects) => {
    const result = await listReadableFileDirectory(app, workspaces, reader, projects, { number: page, limit: 50 })
    const items = result.links.map(({ workspaceId: _workspaceId, driveScope: _scope, volumeName: _name, ...item }) =>
      ({ ...item, automationId: null }))
    return { items, page: result.page, pageCount: result.pageCount, total: result.total }
  })
}
