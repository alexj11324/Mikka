import { cloudComputerTasksEnabled } from '@/lib/cloud-computer-flag'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { z } from 'zod'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ComputerStore } from './store'
import { createComputerHandler } from './handler'
import { ensureCloudBotWorker } from './wake-worker'

export const computerRoute = createComputerHandler(new ComputerStore(pool), async (request, botId) => {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return null
  // The person's Coordinator shows in every workspace, but its bot row and computer live in its own (#757).
  const coordinatorWorkspace = botId && z.uuid().safeParse(botId).success
    ? (await pool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM coordinator_bots WHERE "ownerId"=$1 AND "botId"=$2', [session.user.id, botId])).rows[0]?.workspaceId
    : undefined
  const context = await loadWorkspaceContext(coordinatorWorkspace, session.user)
  return { userId: session.user.id, workspaceId: context.workspace.id }
}, async (actor, botId) => {
  if (!cloudComputerTasksEnabled()) return
  await ensureCloudBotWorker(pool, actor, botId)
})
