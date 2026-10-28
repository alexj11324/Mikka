import { z } from 'zod'
import type { ComputerStore } from './store'

const headers = { 'cache-control': 'private, no-store' }
const input = z.object({ permission: z.enum(['ask', 'deny']) }).strict()

export function createComputerPolicyHandler(deps: {
  enabled(): boolean
  authorize(request: Request, workspaceId: string, admin: boolean): Promise<{ canEdit: boolean } | null>
  store: Pick<ComputerStore, 'policy' | 'setPolicy'>
}) {
  return async (request: Request, workspaceId: string) => {
    if (!deps.enabled()) return request.method === 'GET' ? Response.json({ enabled: false }, { headers }) : Response.json({ error: 'Computer policy unavailable' }, { status: 503, headers })
    if (!z.uuid().safeParse(workspaceId).success) return Response.json({ error: 'Workspace unavailable' }, { status: 403, headers })
    if (request.method !== 'GET' && request.method !== 'POST') return Response.json({ error: 'Method unavailable' }, { status: 405, headers })
    if (request.method === 'POST' && request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Invalid origin' }, { status: 403, headers })
    let member: { canEdit: boolean } | null
    try { member = await deps.authorize(request, workspaceId, request.method === 'POST') }
    catch { return Response.json({ error: 'Computer policy unavailable' }, { status: 503, headers }) }
    if (!member || (request.method === 'POST' && !member.canEdit)) return Response.json({ error: 'Workspace unavailable' }, { status: 403, headers })
    try {
      if (request.method === 'GET') return Response.json({ enabled: true, permission: await deps.store.policy(workspaceId), canEdit: member.canEdit }, { headers })
      if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
      const reader = request.body?.getReader()
      if (!reader) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
      const chunks: Uint8Array[] = []; let size = 0
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break
          size += part.value.length
          if (size > 200) { await reader.cancel(); return Response.json({ error: 'Invalid request' }, { status: 400, headers }) }
          chunks.push(part.value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const parsed = input.safeParse((() => { try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { return null } })())
      if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
      return Response.json(await deps.store.setPolicy(workspaceId, parsed.data.permission), { headers })
    } catch { return Response.json({ error: 'Computer policy unavailable' }, { status: 503, headers }) }
  }
}
