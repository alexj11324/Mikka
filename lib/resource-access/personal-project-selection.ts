import 'server-only'
import { and, eq } from 'drizzle-orm'
import type { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { organizationMemberProjectDefaults as defaults } from '@/lib/db/governance-schema'
import { GovernanceError } from '@/lib/governance/errors'
import { accessibleProjectNames, withReadableProject } from '@/lib/project-access'
import type { changePersonalProject } from '@/lib/project-input'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { memberProjectOrganization } from './project-creation-default'

/** A saved choice never grants Project access. Resolve it against the visible
 * active Projects of this Workspace each time, including after a relink. */
export function personalProjectSelectionFor(reader: { id: string }, workspaceId: string, change?: z.infer<typeof changePersonalProject>) {
  return withTaskWorkspace(reader, workspaceId, async (workspace, tx) => {
    const organizationId = await memberProjectOrganization(tx, workspace, reader.id, Boolean(change))
    if (change && (change.readerId !== reader.id || !organizationId || change.organizationId !== organizationId)) throw new GovernanceError('access_denied')
    if (!organizationId) return { organizationId: null, projectId: null, revision: 0, projects: [] }

    const projects = await accessibleProjectNames(reader, workspaceId, tx)
    const [saved] = await tx.select({ projectId: defaults.defaultProjectId, revision: defaults.selectionRevision }).from(defaults)
      .where(and(eq(defaults.organizationId, organizationId), eq(defaults.userId, reader.id)))
    const projectId = projects.find(project => project.id === saved?.projectId)?.id ?? null
    const current = { organizationId, projectId, revision: saved?.revision ?? 0, projects }
    if (!change) return current
    if (change.projectId && !projects.some(project => project.id === change.projectId)) throw new GovernanceError('not_found')
    const save = async () => {
      // The visible Project can be null in a sibling Workspace while the
      // member still has a saved Organization-wide choice to clear.
      if (change.projectId === (saved?.projectId ?? null)) return current
      if (current.revision !== change.expectedRevision) throw new GovernanceError('project_selection_changed')
      const values = { defaultProjectId: change.projectId, selectionRevision: current.revision + 1 }
      await tx.insert(defaults).values({ organizationId, userId: reader.id, visibility: 'shared', ...values })
        .onConflictDoUpdate({ target: [defaults.organizationId, defaults.userId], set: values })
      return { ...current, projectId: change.projectId, revision: values.selectionRevision }
    }
    if (!change.projectId) return save()
    try {
      return await withReadableProject(reader, workspaceId, change.projectId, save)
    } catch (error) {
      if (error instanceof ActionFailureError && ['issueNotFound', 'projectNotFound'].includes(error.code)) throw new GovernanceError('not_found', error)
      throw error
    }
  })
}
