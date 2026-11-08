import 'server-only'
import { and, eq } from 'drizzle-orm'
import { teams } from '@/lib/db/team-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { lockTeamRelations } from '@/lib/team-access'
import { ActionFailureError } from '@/lib/action-error'
import type { WorkspaceTransaction } from '@/lib/workspace-access'

/** Look up only the tenant first, then lock Workspace → member → relations →
 * Team. This matches Project mutations and prevents a relation/member deadlock. */
export async function withTeamWorkspace<T>(userId: string, teamId: string, operation: (tx: WorkspaceTransaction) => Promise<T>) {
  const [observed] = await workspaceDb.select({ workspaceId: teams.workspaceId }).from(teams).where(eq(teams.id, teamId))
  if (!observed) throw new ActionFailureError('teamIssueAccessDenied')
  return withTaskWorkspace(userId, observed.workspaceId, async (workspace, tx) => {
    if (workspace.kind !== 'team') throw new ActionFailureError('teamIssueAccessDenied')
    await lockTeamRelations(tx)
    const [current] = await tx.select({ id: teams.id }).from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspace.id))).for('share')
    if (!current) throw new ActionFailureError('teamIssueAccessDenied')
    return operation(tx)
  })
}
