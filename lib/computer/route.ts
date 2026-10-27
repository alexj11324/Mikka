import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ComputerStore } from './store'
import { createComputerHandler } from './handler'
import { startCloudWorker } from './cloud-worker'
import { connectComputer } from './e2b-provider'
import { ensureBotRuntime } from './bot-runtime'

export const computerRoute = createComputerHandler(new ComputerStore(pool), async request => {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return null
  const context = await loadWorkspaceContext(undefined, session.user)
  return { userId: session.user.id, workspaceId: context.workspace.id }
}, async (actor, botId) => {
  if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1') return
  const origin = process.env.MIKKA_CLOUD_WORKER_URL
  const sha = process.env.MIKKA_CLOUD_WORKER_SHA
  if (!origin || !sha) throw new Error('Cloud worker is not configured')
  const machine = (await pool.query(`SELECT m."sandboxId" FROM cloud_machines m
    JOIN bot_desktops d ON d."workspaceId"=m."workspaceId" AND d."ownerId"=m."ownerId"
    WHERE m."workspaceId"=$1 AND m."ownerId"=$2 AND d."botId"=$3 AND m.state='running'`,
  [actor.workspaceId, actor.userId, botId])).rows[0]
  if (!machine?.sandboxId) throw new Error('Cloud computer unavailable')
  const sandbox = await connectComputer(machine.sandboxId)
  const worker = await startCloudWorker(pool, actor, sandbox, origin, sha)
  await ensureBotRuntime(pool, actor, botId, sandbox, worker.deviceId)
})
