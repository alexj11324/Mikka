import type { Pool } from 'pg'
import { InboxError } from './contract'
import type { Guard } from './store'

/** Same active member check as requireWorkspace, held while the command runs.
 * Application and workspace tables remain in their respective databases. */
export function createInboxGuard(workspacePool: Pool): Guard { return async (userId, workspaceId, work) => {
  const tx = await workspacePool.connect()
  try {
    await tx.query('BEGIN')
    const { rows: [workspace] } = await tx.query<{ kind: string; userId: string }>(`
      SELECT w.kind,w."userId" FROM mikka_workspaces w JOIN mikka_workspace_members m ON m."workspaceId"=w.id
      WHERE w.id=$1 AND m."userId"=$2 AND m.status='active' FOR SHARE OF w,m`, [workspaceId, userId])
    if (!workspace) throw new InboxError('workspaceAccessDenied', 403)
    const { rows: links } = await tx.query<{ issueId: string; workspaceId: string }>(`
      SELECT l."issueId",l."workspaceId" FROM mikka_team_issues l JOIN mikka_teams t ON t.id=l."teamId" AND t."workspaceId"=l."workspaceId"
      WHERE l."workspaceId"=$1 OR $2`, [workspaceId, workspace.kind === 'personal' && workspace.userId === userId])
    const value = await work({ personal: workspace.kind === 'personal' && workspace.userId === userId,
      issueIds: links.filter(l => l.workspaceId === workspaceId).map(l => l.issueId),
      otherIssueIds: links.filter(l => l.workspaceId !== workspaceId).map(l => l.issueId) })
    await tx.query('COMMIT')
    return value
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
}

}
