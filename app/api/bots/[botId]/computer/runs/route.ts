import { cloudComputerRunsEnabled } from '@/lib/cloud-computer-flag'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { issueForUser } from '@/lib/issue-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ComputerError } from '@/lib/computer/store'
import { chooseCloudRunModel, latestThreadRunModel } from '@/lib/computer/run-model'
import { queueFactoryCloudTask } from '@/lib/factory/task-dispatch'
import { factoryLifecycleEnabled } from '@/lib/factory/runtime'
import { FactoryError } from '@/lib/factory/contract'

const inputSchema = z.object({ issueId: z.uuid(), harness: z.enum(['codex', 'claude_code']), note: z.string().trim().max(10_000).optional() }).strict()
const headers = { 'Cache-Control': 'private, no-store' }

export async function POST(request: Request, { params }: { params: Promise<{ botId: string }> }) {
  if (!factoryLifecycleEnabled()) return Response.json({error:'factoryLifecycleUnavailable'},{status:503,headers})
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
    const runtime = (await pool.query('SELECT "agentId","repoId" FROM bot_cloud_runtimes WHERE "botId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND harness=$4', [botId, session.user.id, context.workspace.id, parsed.data.harness])).rows[0]
    if (!runtime) return Response.json({ error: 'Bot computer task is unavailable' }, { status: 409, headers })
    // One task, one thread (lib/thread-dispatch.ts): a task with a thread gets this as that thread's work.
    const { dispatchToTask } = await import('@/lib/thread-dispatch')
    const result = await dispatchToTask(session.user.id, parsed.data.issueId, {
      note: parsed.data.note,
      // A new thread takes 优先使用的模型's first cloud entry for this harness; the thread's next run keeps its own model.
      start: async (previous, note) => {
        const runModel = previous ? await latestThreadRunModel(pool, session.user.id, parsed.data.issueId, previous.agentId) : await chooseCloudRunModel(pool, { ownerId: session.user.id, workspaceId: context.workspace.id, botId }, runtime.agentId, parsed.data.harness)
        if (!runModel) throw new ComputerError(409, 'threadModelUnavailable')
        if ('error' in runModel) throw new ComputerError(409, 'Bot subscription unavailable')
        return queueFactoryCloudTask(session.user.id,botId,{issueId:issue.id,agentId:runtime.agentId,deviceRepoId:runtime.repoId,note,threadRunId:previous?.id,requestKey:`thread:${previous?.id ?? 'new'}:${crypto.randomUUID()}`},{botId,workspaceId:context.workspace.id},{...runModel,readOnly:previous?.readOnly})
      },
    })
    return Response.json(result, { status: 202, headers })
  } catch (error) {
    if (error instanceof FactoryError) return Response.json({error:error.code},{status:409,headers})
    if (error instanceof ComputerError) return Response.json({ error: error.message }, { status: error.status, headers })
    return Response.json({ error: 'Cloud computer task unavailable' }, { status: 503, headers })
  }
}
