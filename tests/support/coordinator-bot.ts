// The person's Coordinator is an ordinary bot row in the workspace their work
// with no bot runs in (lib/coordinator/coordinator-bot.ts). DB tests give the
// person that workspace, then resolve the Coordinator the way the app does.
import { randomUUID } from 'node:crypto'

/** A personal workspace with the person as its only active member, and their Coordinator's bot id in it. */
export async function seedCoordinator(userId: string): Promise<{ botId: string; workspaceId: string }> {
  const [{ pool }, { coordinatorBot }] = await Promise.all([import('../../lib/db'), import('../../lib/coordinator/coordinator-bot')])
  const workspaceId = randomUUID()
  await pool.query(`insert into mikka_workspaces (id,"userId",name,slug,kind) values ($1,$2,$3,$4,'personal')`, [workspaceId, userId, 'Personal', `ws-${workspaceId.slice(0, 8)}`])
  await pool.query(`insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,'admin','active')`, [workspaceId, userId, `${userId}@example.invalid`])
  return coordinatorBot(userId)
}
