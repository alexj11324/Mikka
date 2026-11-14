import { AgentProfileError } from '@/lib/factory/agent-profile-definition'
import { agentProfileReferenceSchema } from '@/lib/factory/agent-profile-reference'
import { AgentProfileAdmissionError } from '@/lib/factory/profile-admission'
import { cloudComputerRunsEnabled } from '@/lib/cloud-computer-flag'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { issueForUser } from '@/lib/issue-access'
import { tiptapToText } from '@/lib/tiptap-text'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { FactoryError } from '@/lib/factory/contract'
import { ComputerError } from '@/lib/computer/store'
import { latestThreadRunModel } from '@/lib/computer/run-model'
import { queueFactoryCloudRun } from '@/lib/factory/queue-cloud'

const inputSchema = z.object({ issueId: z.uuid(), harness: z.enum(['codex', 'claude_code']).optional(), profileId: agentProfileReferenceSchema.optional(), note: z.string().trim().max(10_000).optional(), needsSpec: z.boolean().optional() }).strict()
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
    // One task, one thread (lib/thread-dispatch.ts): a task with a thread gets this as that thread's work.
    const { dispatchToTask, latestTaskRun } = await import('@/lib/thread-dispatch')
    const previousThread = await latestTaskRun(pool, session.user.id, parsed.data.issueId)
    const sourceEventId = previousThread && parsed.data.note ? await (await import('@/lib/factory/request-epoch')).recordOwnerFactoryContinuation(pool, session.user.id, previousThread.id, parsed.data.note) : undefined
    const result = await dispatchToTask(session.user.id, parsed.data.issueId, {
      note: parsed.data.note, sourceEventId,
      // A new thread takes 优先使用的模型's first cloud entry for this harness; the thread's next run keeps its own model.
      start: async (previous, note) => {
        const scope = { ownerId: session.user.id, workspaceId: context.workspace.id, botId }
        const needsSpec = !previous && await (await import('@/lib/factory/task-dispatch')).factoryTaskNeedsSpec(pool, session.user.id, { issueId: issue.id, botId, needsSpec: parsed.data.needsSpec })
        let runModel: import('@/lib/computer/run-model').RunModel
        let harness: 'claude_code' | 'codex'
        if (previous) {
          if (!previous.cloud || previous.cloud.botId !== botId || (previous.harness !== 'claude_code' && previous.harness !== 'codex')) throw new ComputerError(409, 'threadModelUnavailable')
          const kept = await latestThreadRunModel(pool, session.user.id, parsed.data.issueId, previous.agentId)
          if (!kept || (parsed.data.harness && parsed.data.harness !== previous.harness) ||
            (parsed.data.profileId && parsed.data.profileId !== kept.agentProfile?.profileId)) throw new ComputerError(409, 'threadProfileMismatch')
          runModel = kept
          harness = previous.harness
        } else {
          const { resolveAgentProfileDispatch } = await import('@/lib/factory/agent-profile')
          const picked = await resolveAgentProfileDispatch(pool, scope, { issueId: issue.id, stage: needsSpec ? 'spec' : 'execute', note,
            profileId: parsed.data.profileId, location: 'cloud', cloudPurpose: 'desktop',
            ...(parsed.data.harness ? { asked: { harness: parsed.data.harness } } : {}) })
          const target = picked.target
          if (target.kind !== 'cloud') throw new ComputerError(409, 'agentProfileUnavailable')
          harness = target.harness
          const ready = await (await import('@/lib/computer/auto-runtime')).ensureBotCloudRuntime(pool, { userId: session.user.id, workspaceId: context.workspace.id }, botId, { harness })
          if (!ready) throw new ComputerError(409, 'Bot computer task is unavailable')
          const source = target.entry.source
          runModel = { model: target.model, agentProfile: picked.agentProfile,
            modelDispatch: { mode: picked.selectionMode ?? (parsed.data.harness ? 'picked' : 'preference'), location: 'cloud', entry: target.entry, ...(target.routing ? { routing: target.routing } : {}) },
            ...(source.kind === 'api_key' ? { apiKeyId: source.keyId } : { subscriptionBindingId: await (await import('@/lib/model-dispatch')).bindAgentToConnection(pool, scope, ready.agentId, harness, source.connectionId, target.model) }) }
        }
        const runtime = (await pool.query('SELECT r."agentId",r."repoId",a."deviceId" FROM bot_cloud_runtimes r JOIN agents a ON a.id=r."agentId" WHERE r."botId"=$1 AND r."ownerId"=$2 AND r."workspaceId"=$3 AND r.harness=$4', [botId, session.user.id, context.workspace.id, harness])).rows[0]
        if (!runtime) throw new ComputerError(409, 'Bot computer task is unavailable')
        const actor = { userId: session.user.id, workspaceId: context.workspace.id }
        await (await import('@/lib/computer/dispatch-runtime')).prepareBotCloudTaskRuntime(pool, actor, { botId, agentId: runtime.agentId, harness, ...runModel, ...(previous?.remoteUrl ? { repo: previous.remoteUrl } : {}) })
        const deviceRepoId = previous?.remoteUrl ? (await (await import('@/lib/device-repositories')).ensureDeviceRepository(session.user.id, runtime.deviceId, previous.remoteUrl)).id : runtime.repoId
        return queueFactoryCloudRun(pool, actor, { ownerRequested: session.user.id === issue.userId, issueId: parsed.data.issueId, note, botId, sourceEventId, needsSpec, agentId: runtime.agentId, deviceRepoId, ...(previous?.botId === null ? {withoutBot:true} : {}), title: issue.title, body: tiptapToText(issue.content), ...(previous?.readOnly ? { readOnly: true } : {}), ...(previous ? { idempotencyKey: `thread:${previous.id}:${sourceEventId ?? crypto.randomUUID()}` } : {}), ...runModel, ...(previous ? { threadRunId: previous.id } : {}) })
      },
    })
    if ('runId' in result && result.thread !== 'message') await (await import('@/lib/run-leases')).startThreadMachine({ userId: session.user.id, workspaceId: context.workspace.id }, result.runId)
    return Response.json(result, { status: 202, headers })
  } catch (error) {
    if (error instanceof AgentProfileError) return Response.json({ error: error.code }, { status: error.status, headers })
    if (error instanceof AgentProfileAdmissionError) return Response.json({ error: error.message }, { status: 409, headers })
    if (error instanceof FactoryError) return Response.json({ error: error.code }, { status: 409, headers })
    if (error instanceof ComputerError) return Response.json({ error: error.message }, { status: error.status, headers })
    return Response.json({ error: 'Cloud computer task unavailable' }, { status: 503, headers })
  }
}
