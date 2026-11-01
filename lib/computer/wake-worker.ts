import 'server-only'
import type { Pool } from 'pg'
import { startCloudWorker } from './cloud-worker'
import { connectComputer } from './e2b-provider'
import { ensureBotRuntime } from './bot-runtime'
import { CloudWorkerError } from './worker-error'

/** Called only after the desktop transaction has committed. */
export async function ensureCloudBotWorker(pool: Pool, actor: { userId: string; workspaceId: string }, botId: string) {
  const origin = process.env.MIKKA_CLOUD_WORKER_URL
  const sha = process.env.MIKKA_CLOUD_WORKER_SHA
  if (!origin || !sha) throw new CloudWorkerError('worker_unconfigured')
  const machine = (await pool.query(`SELECT m."sandboxId" FROM cloud_machines m
    JOIN bot_desktops d ON d."workspaceId"=m."workspaceId" AND d."ownerId"=m."ownerId"
    WHERE m."workspaceId"=$1 AND m."ownerId"=$2 AND d."botId"=$3 AND m.state='running'`,
  [actor.workspaceId, actor.userId, botId])).rows[0]
  if (!machine?.sandboxId) throw new CloudWorkerError('machine_unavailable')
  const sandbox = await connectComputer(actor.workspaceId, machine.sandboxId)
  const worker = await startCloudWorker(pool, actor, sandbox, origin, sha)
  return ensureBotRuntime(pool, actor, botId, sandbox, worker.deviceId)
}
