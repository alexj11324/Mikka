import { z } from 'zod'
import { ModelAdmissionError } from './contract'
import type { ModelAdmissionStore } from './store'

const command = z.strictObject({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), policy: z.unknown() })
export function createModelAdmissionHandler(dependencies: {
  store: Pick<ModelAdmissionStore, 'read' | 'set'>
  principal(request: Request, workspaceId: string): Promise<string | null>
}) {
  return async (request: Request, workspaceId: string) => {
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
    if (!z.uuid().safeParse(workspaceId).success) return reply({ error: 'invalidRequest' }, 400)
    if (request.method !== 'GET' && request.method !== 'POST') return reply({ error: 'methodNotAllowed' }, 405)
    if (request.method === 'POST' && request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'originRejected' }, 403)
    const ownerId = await dependencies.principal(request, workspaceId)
    if (!ownerId) return reply({ error: 'unauthorized' }, 401)
    try {
      const scope = { workspaceId, ownerId }
      if (request.method === 'GET') return reply(await dependencies.store.read(scope))
      const reader = request.body?.getReader()
      if (!reader) return reply({ error: 'invalidRequest' }, 400)
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 16_384) return reply({ error: 'bodyTooLarge' }, 413)
          chunks.push(chunk.value)
        }
      } finally { await reader.cancel() }
      let input: unknown
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
      catch { return reply({ error: 'invalidRequest' }, 400) }
      const parsed = command.safeParse(input)
      if (!parsed.success) return reply({ error: 'invalidRequest' }, 400)
      return reply(await dependencies.store.set(scope, parsed.data.expectedRevision, parsed.data.policy))
    } catch (error) {
      if (error instanceof ModelAdmissionError) return reply({ error: error.code }, error.code === 'modelPrincipalUnavailable' ? 403 : 409)
      // Store/lease failures are unavailable authority, never a provider retry.
      return reply({ error: 'modelAdmissionUnavailable' }, 503)
    }
  }
}
