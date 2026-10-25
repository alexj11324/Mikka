import { z } from 'zod'
import { commandSchema, ImprovementError } from './contract'
import type { createImprovementStore } from './store'

export async function handleImprovement(store: ReturnType<typeof createImprovementStore>, request: Request, userId: string | null): Promise<Response> {
  const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
  if (!userId) return respond({ error: 'authRequired' }, 401)
  if (!['GET', 'POST'].includes(request.method)) return respond({ error: 'methodNotAllowed' }, 405)
  try {
    if (request.method === 'GET') {
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
    return respond(parsed.data.action === 'feedback'
      ? await store.recordFeedback(userId, parsed.data)
      : await store.propose(userId, parsed.data.runId))
  } catch (error) {
    if (!(error instanceof ImprovementError)) throw error
    return respond({ error: error.code }, error.code === 'notFound' ? 404 : error.code === 'invalid' ? 422 : 409)
  }
}
