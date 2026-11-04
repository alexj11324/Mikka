import { cloudComputerRunsEnabled } from '@/lib/cloud-computer-flag'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { issueForUser } from '@/lib/issue-access'
import { tiptapToText } from '@/lib/tiptap-text'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { FactoryError } from '@/lib/factory/contract'
import { ComputerError } from '@/lib/computer/store'
import { chooseCloudRunModel, latestThreadRunModel } from '@/lib/computer/run-model'
import { queueFactoryCloudRun } from '@/lib/factory/queue-cloud'

const inputSchema = z.object({ issueId: z.uuid(), harness: z.enum(['codex', 'claude_code']), note: z.string().trim().max(10_000).optional() }).strict()
const headers = { 'Cache-Control': 'private, no-store' }

export async function POST(request: Request, { params }: { params: Promise<{ botId: string }> }) {
  if (!cloudComputerRunsEnabled()) return Response.json({ error: 'Cloud computer task unavailable' }, { status: 503, headers })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'Sign in required' }, { status: 401, headers })
  if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Invalid origin' }, { status: 403, headers })
  const botId = (await params).botId
  const raw = await request.text()
  if (raw.length > 12_000 || !z.uuid().safeParse(botId).success) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
  const parsed = inputSchema.safeParse((() => { try { return JSON.parse(raw) } catch { return null } })())
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
  try {
    const [issue, context] = await Promise.all([issueForUser(session.user, parsed.data.issueId), loadWorkspaceContext(undefined, session.user)])
    if (!issue) return Response.json({ error: 'Task unavailable' }, { status: 404, headers })
    const runtime = (await pool.query('SELECT r."agentId",r."repoId",a."deviceId" FROM bot_cloud_runtimes r JOIN agents a ON a.id=r."agentId" WHERE r."botId"=$1 AND r."ownerId"=$2 AND r."workspaceId"=$3 AND r.harness=$4', [botId, session.user.id, context.workspace.id, parsed.data.harness])).rows[0]
    if (!runtime) return Response.json({ error: 'Bot computer task is unavailable' }, { status: 409, headers })
    // One task, one thread (lib/thread-dispatch.ts): a task with a thread gets this as that thread's work.
    const { dispatchToTask, latestTaskRun } = await import('@/lib/thread-dispatch')
    const previousThread = await latestTaskRun(pool, session.user.id, parsed.data.issueId)
    const sourceEventId = previousThread && parsed.data.note ? await (await import('@/lib/factory/request-epoch')).recordOwnerFactoryContinuation(pool, session.user.id, previousThread.id, parsed.data.note) : undefined
    const result = await dispatchToTask(session.user.id, parsed.data.issueId, {
      note: parsed.data.note, sourceEventId,
      // A new thread takes 优先使用的模型's first cloud entry for this harness; the thread's next run keeps its own model.
      start: async (previous, note) => {
        const deviceRepoId = previous?.remoteUrl ? (await (await import('@/lib/device-repositories')).ensureDeviceRepository(session.user.id,runtime.deviceId,previous.remoteUrl)).id : runtime.repoId
        const runModel = previous ? await latestThreadRunModel(pool, session.user.id, parsed.data.issueId, previous.agentId) : await chooseCloudRunModel(pool, { ownerId: session.user.id, workspaceId: context.workspace.id, botId }, runtime.agentId, parsed.data.harness)
        if (!runModel) throw new ComputerError(409, 'threadModelUnavailable')
        if ('error' in runModel) throw new ComputerError(409, 'Bot subscription unavailable')
        return queueFactoryCloudRun(pool, { userId: session.user.id, workspaceId: context.workspace.id }, { issueId: parsed.data.issueId, note, botId, sourceEventId, agentId: runtime.agentId, deviceRepoId, ...(previous?.botId === null ? {withoutBot:true} : {}), title: issue.title, body: tiptapToText(issue.content), ...(previous?.readOnly ? { readOnly: true } : {}), ...(previous ? { idempotencyKey: `thread:${previous.id}:${sourceEventId ?? crypto.randomUUID()}` } : {}), ...runModel, ...(previous ? { threadRunId: previous.id } : {}) })
      },
    })
    if ('runId' in result && result.thread !== 'message') await (await import('@/lib/run-leases')).startThreadMachine({ userId: session.user.id, workspaceId: context.workspace.id }, result.runId)
    return Response.json(result, { status: 202, headers })
  } catch (error) {
    if (error instanceof FactoryError) return Response.json({ error: error.code }, { status: 409, headers })
    if (error instanceof ComputerError) return Response.json({ error: error.message }, { status: error.status, headers })
    return Response.json({ error: 'Cloud computer task unavailable' }, { status: 503, headers })
  }
}
