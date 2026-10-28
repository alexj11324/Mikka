import { z } from 'zod'
import type { EnrollmentClient } from './subscription-enrollment'

const input = z.object({ id: z.uuid(), workspaceId: z.uuid(), proof: z.string().min(1).max(2048).optional() }).strict()
export function enrollmentBindHTTP(deps: {
  operator(request: Request): Promise<string | null>
  handoff?(request: Request, userId: string, body: z.infer<typeof input>): Promise<string | null>
  session(request: Request): Promise<{ userId: string } | null>
  workspace(userId: string, workspaceId: string): Promise<void>
  client(): Pick<EnrollmentClient, 'bind'>
}) {
  return async (request: Request) => {
    const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' }
    try {
      if (request.method !== 'POST' || request.headers.get('sec-fetch-site') === 'cross-site' || (request.headers.has('origin') && request.headers.get('origin') !== new URL(request.url).origin)) return Response.json({ error: 'request_refused' }, { status: 403, headers })
      const directPrincipal = await deps.operator(request)
      if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'invalid_request' }, { status: 415, headers })
      const reader = request.body?.getReader(); if (!reader) throw new Error()
      const chunks: Uint8Array[] = []; let size = 0
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); throw new Error() }; chunks.push(value) } } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const parsed = input.safeParse(JSON.parse(new TextDecoder().decode(bytes)))
      // No operator or scoped proof: refuse before loading DB-backed auth.
      // Initial custody-only deployments must retain this unauthenticated path.
      if (!directPrincipal && (!parsed.success || !parsed.data.proof)) return Response.json({ error: 'auth_required' }, { status: 401, headers })
      if (!parsed.success) throw new Error('invalid_request')
      const body = parsed.data
      const session = await deps.session(request)
      if (!session) return Response.json({ error: 'auth_required' }, { status: 401, headers })
      const principal = directPrincipal ?? await deps.handoff?.(request, session.userId, body)
      if (!principal) return Response.json({ error: 'auth_required' }, { status: 401, headers })
      await deps.workspace(session.userId, body.workspaceId)
      return Response.json(await deps.client().bind(principal, body.id, session.userId, body.workspaceId), { headers })
    } catch { return Response.json({ error: 'subscription_binding_unavailable' }, { status: 409, headers }) }
  }
}
