import 'server-only'
import { inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { projectDb, projects } from '@/lib/db/projects'
import { activeTaskWorkspaces, taskReaderScope } from '@/lib/task-workspace'
import type { IssueReader } from '@/lib/issue-visibility'
import type { ResourceReference } from '@/lib/resource-access/contract'

export type ProjectTransaction = Parameters<Parameters<typeof projectDb.transaction>[0]>[0]

/** Tenant and Enterprise admission precede APP content ACLs. Source Project
 * rows are read only after their stable IDs pass the authoritative ACL; no
 * request cache can preserve access after a grant or membership revocation.
 * A selected Workspace is required: omitting it must never enumerate every
 * tenant of a human who belongs to more than one. */
export async function accessibleProjectReferences(reader: IssueReader, workspaceId: string): Promise<ResourceReference[]> {
  if (!z.uuid().safeParse(workspaceId).success) return []
  const tenants = await activeTaskWorkspaces(reader, workspaceId)
  if (!tenants.length) return []
  const { rows } = await db.execute<{ id: string; workspaceId: string }>(sql`select id,"workspaceId" from resource_access_policies
    where kind='project' and "workspaceId"=any(${sql.param(tenants.map(tenant => tenant.id))}::uuid[])
      and mikka_resource_acl_allowed('account',${taskReaderScope(reader).userId},"workspaceId",kind,id,'canReadContent')`)
  return rows.map(row => ({ ...row, kind: 'project' }))
}

export async function accessibleProjects(reader: IssueReader, tx: ProjectTransaction | typeof projectDb, workspaceId: string) {
  const references = await accessibleProjectReferences(reader, workspaceId)
  if(!references.length)return []
  const ids=references.map(row=>row.id)
  const [source,{rows:tasks}]=await Promise.all([
    tx.select().from(projects).where(inArray(projects.id,ids)),
    db.execute<{id:string;projectId:string}>(sql`select p.id,p."parentId" as "projectId" from resource_access_policies p
      join issues i on i.id=p.id and i."workspaceId"=p."workspaceId" and i."ownershipState"='bound'
      where p.kind='task' and p."parentKind"='project' and p."parentId"=any(${sql.param(ids)}::uuid[])
        and coalesce(i.content->'attrs'->'mikka',i.content->'attrs'->'orvilo')->>'deletedAt' is null
        and mikka_resource_acl_allowed('account',${taskReaderScope(reader).userId},p."workspaceId",p.kind,p.id,'canReadContent')`),
  ])
  // Source relation arrays are projections, never a way to expose a private
  // child's ID/count. The APP parent is also established before a new Task's
  // content can commit, including the Coordinator/Factory creation path.
  return source.map(project=>({...project,issueIds:tasks.filter(task=>task.projectId===project.id).map(task=>task.id),
    properties:{...project.properties,dependencyIds:project.properties.dependencyIds.filter(id=>ids.includes(id))}}))
}
