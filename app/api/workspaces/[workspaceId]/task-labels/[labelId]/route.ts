import { z } from 'zod'
import { freshSessionRoute } from '@/lib/fresh-session'
import { GovernanceError } from '@/lib/governance/errors'
import { governanceJson, governanceMutationSession, governanceSession } from '@/lib/governance/http'
import { taskLabelsResponse } from '@/lib/task-labels/http'
import { deleteWorkspaceTaskLabel, readWorkspaceTaskLabels, updateWorkspaceTaskLabel } from '@/lib/task-labels/store'

type Context = { params: Promise<{ workspaceId: string; labelId: string }> }
export const GET = freshSessionRoute((request: Request, context: Context) => taskLabelsResponse(async () => {
  const { workspaceId, labelId } = await context.params
  z.uuid().parse(labelId)
  const view = await readWorkspaceTaskLabels((await governanceSession(request, workspaceId)).user, workspaceId)
  const label = view.labels.find(item => item.id === labelId)
  if (!label) throw new GovernanceError('not_found')
  return { workspaceId, source: view.source, canManage: view.canManage, label }
}))
export const PATCH = freshSessionRoute((request: Request, context: Context) => taskLabelsResponse(async () => {
  const { workspaceId, labelId } = await context.params
  const session = await governanceMutationSession(request, workspaceId)
  return updateWorkspaceTaskLabel(session.user, workspaceId, labelId, await governanceJson(request))
}))
export const DELETE = freshSessionRoute((request: Request, context: Context) => taskLabelsResponse(async () => {
  const { workspaceId, labelId } = await context.params
  const session = await governanceMutationSession(request, workspaceId)
  return deleteWorkspaceTaskLabel(session.user, workspaceId, labelId)
}))
