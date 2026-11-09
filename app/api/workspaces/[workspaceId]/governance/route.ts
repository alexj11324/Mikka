import { and, asc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace } from '@/lib/workspace-access'
import { governanceApprovalTemplates } from '@/lib/db/team-entitlements-schema'
import { organizationMembers, organizations } from '@/lib/db/governance-schema'
import { workspaceGovernanceSummary } from '@/lib/governance/entitlements'
import { governanceJson, governanceResponse, governanceSession } from '@/lib/governance/http'
import { applyApprovalTemplate, deleteApprovalTemplate, saveApprovalTemplate } from '@/lib/governance/templates'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
export const runtime = 'nodejs'
type Context = { params: Promise<{ workspaceId: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId } = await context.params
  const session = await governanceSession(request, workspaceId)
  return workspaceDb.transaction(async tx => {
    const { membership } = await requireWorkspace(tx, workspaceId, session.user.id, false, session.user[enterprisePrincipal])
    const summary = await workspaceGovernanceSummary(tx, workspaceId)
    const canEdit = membership.role === 'admin'
    const templates = canEdit && summary.approvalTemplates ? await tx.select().from(governanceApprovalTemplates).where(eq(governanceApprovalTemplates.workspaceId, workspaceId)).orderBy(asc(governanceApprovalTemplates.createdAt)) : []
    const ownedOrganizations = canEdit ? await tx.select({ id: organizations.id, name: organizations.name, role: organizationMembers.role }).from(organizations).innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id)).where(and(eq(organizationMembers.userId, session.user.id), eq(organizationMembers.status, 'active'), isNull(organizations.archivedAt))) : []
    return { ...summary, canEdit, templates, organizations: ownedOrganizations.filter(row => row.role !== 'member') }
  })
}))

const operation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), template: z.unknown() }).strict(),
  z.object({ action: z.enum(['delete', 'apply']), templateId: z.uuid() }).strict(),
])
export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId } = await context.params
  const session = await governanceSession(request, workspaceId)
  const value = operation.parse(await governanceJson(request))
  if (value.action === 'save') return saveApprovalTemplate(workspaceId, session.user, value.template)
  if (value.action === 'apply') return applyApprovalTemplate(workspaceId, session.user, value.templateId)
  await deleteApprovalTemplate(workspaceId, session.user, value.templateId)
  return { deleted: true }
}))
