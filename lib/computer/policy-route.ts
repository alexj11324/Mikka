import { z } from 'zod'
import type { ComputerStore } from './store'
import { computerPermissions, type ComputerPermission } from './permission'

const headers = { 'cache-control': 'private, no-store' }
const input = z.object({ permission: z.enum(computerPermissions) }).strict()

async function readPermission(request: Request): Promise<ComputerPermission | null> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break
      size += part.value.length
      if (size > 200) { await reader.cancel(); return null }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const parsed = input.safeParse((() => { try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { return null } })())
  return parsed.success ? parsed.data.permission : null
}

export function createComputerPolicyHandler(deps: {
  enabled(): boolean
  withMember(request: Request, workspaceId: string, admin: boolean, operation: (canEdit: boolean) => Promise<Response>): Promise<Response | null>
  store: Pick<ComputerStore, 'policy' | 'setPolicy'>
}) {
  return async (request: Request, workspaceId: string) => {
    if (!deps.enabled()) return request.method === 'GET' ? Response.json({ enabled: false }, { headers }) : Response.json({ error: 'Computer policy unavailable' }, { status: 503, headers })
    if (!z.uuid().safeParse(workspaceId).success) return Response.json({ error: 'Workspace unavailable' }, { status: 403, headers })
    if (request.method !== 'GET' && request.method !== 'POST') return Response.json({ error: 'Method unavailable' }, { status: 405, headers })
    if (request.method === 'POST' && request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Invalid origin' }, { status: 403, headers })
    const denied = () => Response.json({ error: 'Workspace unavailable' }, { status: 403, headers })
    try {
      const write = request.method === 'POST'
      const permission = write ? await readPermission(request) : null
      return await deps.withMember(request, workspaceId, write, async canEdit => {
        if (!write) return Response.json({ enabled: true, permission: await deps.store.policy(workspaceId), canEdit }, { headers })
        if (!canEdit) return denied()
        if (!permission) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
        return Response.json(await deps.store.setPolicy(workspaceId, permission), { headers })
      }) ?? denied()
    } catch { return Response.json({ error: 'Computer policy unavailable' }, { status: 503, headers }) }
  }
}
