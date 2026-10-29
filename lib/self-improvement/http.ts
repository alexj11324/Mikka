import { z } from 'zod'
import { commandSchema, ImprovementError } from './contract'
import type { createImprovementStore } from './store'
import type { createSkillAssignments } from './assignments'
import type { createImprovementFactoryBridge } from './factory-bridge'
import type { createSkillRegistry } from './registry'
import type { createSkillEvaluations } from './evaluations'
import { FactoryError } from '../factory/contract'

export async function handleImprovement(store: ReturnType<typeof createImprovementStore>, request: Request, userId: string | null,
  assignments?: ReturnType<typeof createSkillAssignments>, bridge?: ReturnType<typeof createImprovementFactoryBridge>, registry?: Pick<ReturnType<typeof createSkillRegistry>, 'registerCandidate'>, evaluations?: Pick<ReturnType<typeof createSkillEvaluations>, 'freezeBenchmark' | 'dispatchNext' | 'beginEvaluation' | 'compare'>): Promise<Response> {
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  if (!userId) return respond({ error: 'authRequired' }, 401)
  if (!['GET', 'POST'].includes(request.method)) return respond({ error: 'methodNotAllowed' }, 405)
  try {
    if (request.method === 'GET') {
      const proposalId = new URL(request.url).searchParams.get('proposalId')
      if (proposalId && bridge) {
        if (!z.uuid().safeParse(proposalId).success) return respond({ error:'invalid' },422)
        return respond(await bridge.status(userId,proposalId))
      }
      const runId = new URL(request.url).searchParams.get('runId')
      if (!z.uuid().safeParse(runId).success) return respond({ error: 'invalid' }, 422)
      return respond(await store.read(userId, runId!))
    }
    if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'originRejected' }, 403)
    // Bound bytes before JSON parsing, even for chunked requests.
    const reader = request.body?.getReader()
    if (!reader) return respond({ error: 'invalid' }, 422)
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 16384) { await reader.cancel(); return respond({ error: 'bodyTooLarge' }, 413) }
      chunks.push(chunk.value)
    }
    let body: unknown
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return respond({ error: 'invalid' }, 422) }
    const parsed = commandSchema.safeParse(body)
    if (!parsed.success) return respond({ error: 'invalid' }, 422)
    if (parsed.data.action === 'freeze_benchmark' || parsed.data.action === 'dispatch_training' || parsed.data.action === 'begin_evaluation' ||
      parsed.data.action === 'dispatch_evaluation' || parsed.data.action === 'compare_evaluation') {
      if (!evaluations) return respond({ error: 'sourceRequired' }, 409)
      switch (parsed.data.action) {
        case 'freeze_benchmark': return respond(await evaluations.freezeBenchmark(userId, parsed.data.sourceRunId))
        case 'dispatch_training': return respond(await evaluations.dispatchNext(userId, parsed.data.instanceId, true))
        case 'begin_evaluation': return respond(await evaluations.beginEvaluation(userId, parsed.data.instanceId, parsed.data.proposalId, parsed.data.candidateVersionId))
        case 'dispatch_evaluation': return respond(await evaluations.dispatchNext(userId, parsed.data.evaluationId, false))
        case 'compare_evaluation': return respond(await evaluations.compare(userId, parsed.data.evaluationId))
      }
    }
    if (parsed.data.action === 'select_baseline') {
      if (!assignments) return respond({ error: 'sourceRequired' }, 409)
      return respond(await assignments.selectBaseline(userId, parsed.data.runId))
    }
    if (parsed.data.action === 'select_active') {
      if (!assignments) return respond({ error: 'sourceRequired' }, 409)
      return respond(await assignments.selectActive(userId, parsed.data.runId))
    }
    if (parsed.data.action === 'register_candidate') {
      if (!registry) return respond({ error: 'sourceRequired' }, 409)
      return respond(await registry.registerCandidate(userId, { proposalId: parsed.data.proposalId, binding: parsed.data.binding }))
    }
    if (parsed.data.action === 'handoff') {
      if (!bridge) return respond({ error:'sourceRequired' },409)
      return respond(await bridge.handoff(userId,parsed.data))
    }
    if (parsed.data.action === 'rehearse') {
      if (!bridge) return respond({ error:'sourceRequired' },409)
      return respond(await bridge.rehearse(userId,parsed.data))
    }
    return respond(parsed.data.action === 'feedback'
      ? await store.recordFeedback(userId, parsed.data)
      : await store.propose(userId, parsed.data.runId))
  } catch (error) {
    if (error instanceof FactoryError) return respond({ error:error.code },error.code === 'factoryNotFound' ? 404 : 409)
    if (!(error instanceof ImprovementError)) throw error
    return respond({ error: error.code }, error.code === 'notFound' ? 404 : error.code === 'invalid' ? 422 : 409)
  }
}
