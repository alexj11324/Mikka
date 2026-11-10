import 'server-only'
import { and,eq,inArray,sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import type { IssueReader } from '@/lib/issue-visibility'
import type { ResourceAction,ResourceReference } from './contract'
import { readResourceCapabilities,readResourceManagementMetadata,requireResourceAccess } from './store'

/** The sharing sheet is a content action. An admin's separate management
 * projection does not make this sheet or its membership grants accessible. */
export async function resourceAccessView(reader:IssueReader,reference:ResourceReference) {
  await requireResourceAccess(reader,reference,'canReadContent')
  const capabilities = await readResourceCapabilities(reader,reference)
  const policy = await readResourceManagementMetadata(reader,reference)
  const { rows:grants } = capabilities.canManageAccess ? await db.execute<{subjectId:string;capabilities:ResourceAction[];expiresAt:Date|null}>(sql`
    select "subjectId",capabilities,"expiresAt" from resource_access_grants where "resourceKind"=${reference.kind} and "resourceId"=${reference.id}::uuid
      and "subjectKind"='account' order by "subjectId"`) : { rows:[] }
  const memberIds = capabilities.canManageAccess ? await workspaceDb.select({id:workspaceMembers.userId}).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId,reference.workspaceId),eq(workspaceMembers.status,'active'))) : []
  const members = memberIds.length ? await db.select({id:users.id,name:users.name,image:users.image}).from(users)
    .where(inArray(users.id,memberIds.map(member=>member.id))) : []
  return { policy,capabilities,members,grants:grants.map(grant=>({...grant,expiresAt:grant.expiresAt?.toISOString()??null})) }
}
export type ResourceAccessView = Awaited<ReturnType<typeof resourceAccessView>>
