import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { organizationAccountSession } from '@/lib/enterprise/http'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { organizationMemberProjectDefaults } from '@/lib/db/governance-schema'
import { projectVisibilityDefault } from '@/lib/project-input'
import { resolveProjectVisibilityDefault } from '@/lib/resource-access/project-creation-default'
import { withTaskWorkspace } from '@/lib/task-workspace'

type Context = { params: Promise<{ workspaceId: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  const { workspaceId } = await context.params
  return withTaskWorkspace(session.user, workspaceId, (workspace, tx) => resolveProjectVisibilityDefault(tx, workspace, session.user.id))
}))

const change = z.strictObject({ organizationId: z.uuid(), expectedVisibility: projectVisibilityDefault.shape.visibility, visibility: projectVisibilityDefault.shape.visibility })

export const PUT = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const session = await organizationAccountSession(request)
  const { workspaceId } = await context.params
  const input = change.parse(await governanceJson(request))
  return withTaskWorkspace(session.user, workspaceId, async (workspace, tx) => {
    const current = await resolveProjectVisibilityDefault(tx, workspace, session.user.id, true)
    if (!current.organizationId || current.organizationId !== input.organizationId) throw new GovernanceError('access_denied')
    if (current.visibility === input.visibility) return current
    if (current.visibility !== input.expectedVisibility) throw new GovernanceError('project_visibility_changed')
    const values = { organizationId: current.organizationId, userId: session.user.id, visibility: input.visibility }
    await tx.insert(organizationMemberProjectDefaults).values(values).onConflictDoUpdate({
      target: [organizationMemberProjectDefaults.organizationId, organizationMemberProjectDefaults.userId], set: { visibility: input.visibility },
    })
    return { organizationId: current.organizationId, visibility: input.visibility }
  })
}))
