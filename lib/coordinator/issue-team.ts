import 'server-only'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'

export type IssueTeamChoice =
  | { teamId: string }
  | { teamId: null }
  | { error: 'issueTeamRequired'; teams: { id: string; name: string }[] }

/**
 * Where a bot's create_issue puts the task: a bot in a team workspace creates it in that
 * workspace's team, never as its owner's personal task (decision 2026-11-01-2310: a team's
 * work stays in the team). The host decides from the bot's own workspace; the model only
 * names one of these teams when the person picked it among several. A personal workspace,
 * or a team workspace with no team, keeps the personal task.
 */
export async function coordinatorIssueTeam(userId: string, botId: string, requestedTeamId?: string): Promise<IssueTeamChoice> {
  const bot = (await pool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 AND "archivedAt" IS NULL', [botId, userId])).rows[0]
  if (!bot) return { teamId: null }
  const { rows } = await workspacePool.query<{ id: string; name: string; isMember: boolean }>(`SELECT t.id,t.name,EXISTS (SELECT 1 FROM mikka_team_members tm WHERE tm."teamId"=t.id AND tm."userId"=$2) AS "isMember"
    FROM mikka_teams t
    JOIN mikka_workspaces w ON w.id=t."workspaceId" AND w.kind='team'
    JOIN mikka_workspace_members m ON m."workspaceId"=t."workspaceId" AND m."userId"=$2 AND m.status='active'
    WHERE t."workspaceId"=$1 ORDER BY t."createdAt",t.id`, [bot.workspaceId, userId])
  if (requestedTeamId) {
    const team = rows.find(row => row.id === requestedTeamId)
    return team ? { teamId: team.id } : { error: 'issueTeamRequired', teams: rows.map(({ id, name }) => ({ id, name })) }
  }
  // The person's own teams come first; any team of the workspace counts when they belong to none.
  const mine = rows.filter(row => row.isMember)
  const candidates = mine.length ? mine : rows
  if (candidates.length === 0) return { teamId: null }
  if (candidates.length === 1) return { teamId: candidates[0]!.id }
  return { error: 'issueTeamRequired', teams: candidates.map(({ id, name }) => ({ id, name })) }
}
