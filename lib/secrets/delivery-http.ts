// Human configuration surface only. It changes delivery metadata on existing
// secrets through the stores' ownership, membership, locking and audit rules.
// No secret value, ciphertext or encryption operation enters this handler.
import { z } from 'zod'
import { humanSessionHeaders } from '../desktop-rpc/handler'
import { WorkspaceError } from '../workspace-error'
import { effectiveSecretDelivery, secretDeliveryInput, type SecretDeliveryInput } from './delivery'
import type { UserSecretView } from './user-store'
import type { WorkspaceSecretView } from './store'

export const SECRET_DELIVERY_MAX_BODY_BYTES = 128 * 1024
export interface SecretDeliveryActor { id: string; name: string }
interface HumanSession { user: SecretDeliveryActor; session: { id: string }; tokenWorkspaceId?: string }
interface DeliveryUpdate { id: string; delivery: SecretDeliveryInput }
type Metadata = UserSecretView | WorkspaceSecretView

const selection = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('personal') }).strict(),
  z.object({ scope: z.literal('workspace'), workspaceId: z.uuid() }).strict(),
])
const command = z.object({ id: z.uuid(), workspaceId: z.uuid().optional(), delivery: secretDeliveryInput }).strict()

function metadata(row: Metadata) {
  // Explicit projection also prevents a later store expansion accidentally
  // turning this route into a value/ciphertext retrieval endpoint.
  if (row.kind !== 'secret') throw new WorkspaceError('validationGeneric')
  return {
    id: row.id, name: row.name, kind: row.kind, note: row.note, updatedAt: row.updatedAt,
    delivery: effectiveSecretDelivery(row.delivery),
    ...('scopeType' in row ? { scopeType: row.scopeType, scopeRef: row.scopeRef, updatedBy: row.updatedBy } : {}),
  }
}

async function readBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: number }> {
  if (Number(request.headers.get('content-length')) > SECRET_DELIVERY_MAX_BODY_BYTES) return { ok: false, status: 413 }
  const reader = request.body?.getReader()
  if (!reader) return { ok: false, status: 400 }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > SECRET_DELIVERY_MAX_BODY_BYTES) return { ok: false, status: 413 }
      chunks.push(chunk.value)
    }
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  } catch { return { ok: false, status: 400 } }
  finally { await reader.cancel().catch(() => {}) }
}

export function createSecretDeliveryHandler(dependencies: {
  // Bind to real Better Auth, not the API adapter which also accepts PATs.
  getSession(input: { headers: Headers; query: { disableCookieCache: true } }): Promise<HumanSession | null>
  listPersonal(actor: SecretDeliveryActor): Promise<UserSecretView[]>
  listWorkspace(actor: SecretDeliveryActor, workspaceId: string): Promise<WorkspaceSecretView[]>
  replacePersonal(actor: SecretDeliveryActor, input: DeliveryUpdate): Promise<UserSecretView>
  replaceWorkspace(actor: SecretDeliveryActor, workspaceId: string, input: DeliveryUpdate, request: Request): Promise<WorkspaceSecretView>
}) {
  return async (request: Request): Promise<Response> => {
    const reply = (body: unknown, status = 200) => Response.json(body, {
      status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization', 'X-Content-Type-Options': 'nosniff' },
    })
    if (request.method !== 'GET' && request.method !== 'PATCH') return reply({ error: 'methodNotAllowed' }, 405)
    const url = new URL(request.url)
    const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site')
    if ((origin !== null && origin !== url.origin) || (site !== null && site !== 'same-origin' && site !== 'none')
      || request.method === 'PATCH' && origin !== url.origin) return reply({ error: 'originRejected' }, 403)
    // Match delegated prefixes case-insensitively as an additional guard. A
    // valid-looking opaque device token still fails the real session lookup,
    // with its ambient cookie removed by humanSessionHeaders.
    if (/^Bearer\s+(?:mkp_|mka_|mkr_|mksvc_)/i.test(request.headers.get('authorization') ?? '')) return reply({ error: 'authRequired' }, 401)
    const sessionHeaders = humanSessionHeaders(request)
    if (!sessionHeaders) return reply({ error: 'authRequired' }, 401)
    try {
      const session = await dependencies.getSession({ headers: sessionHeaders, query: { disableCookieCache: true } })
      if (!session?.user?.id || !session.session?.id || session.tokenWorkspaceId || session.session.id.startsWith('pat:'))
        return reply({ error: 'authRequired' }, 401)
      const actor = { id: session.user.id, name: session.user.name }
      if (request.method === 'GET') {
        const entries = [...url.searchParams.entries()]
        if (new Set(entries.map(([key]) => key)).size !== entries.length) return reply({ error: 'validationGeneric' }, 400)
        const parsed = selection.safeParse(Object.fromEntries(entries))
        if (!parsed.success) return reply({ error: 'validationGeneric' }, 400)
        const scope = parsed.data
        const rows = scope.scope === 'personal' ? await dependencies.listPersonal(actor)
          : await dependencies.listWorkspace(actor, scope.workspaceId)
        return reply({ ...scope, secrets: rows.filter(row => row.kind === 'secret').map(metadata) })
      }
      if (url.search || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
        return reply({ error: 'validationGeneric' }, 400)
      const body = await readBody(request)
      if (!body.ok) return reply({ error: body.status === 413 ? 'bodyTooLarge' : 'validationGeneric' }, body.status)
      const parsed = command.safeParse(body.value)
      if (!parsed.success) return reply({ error: 'validationGeneric' }, 400)
      const { workspaceId, id, delivery } = parsed.data
      const input = { id, delivery }
      const saved = workspaceId ? await dependencies.replaceWorkspace(actor, workspaceId, input, request)
        : await dependencies.replacePersonal(actor, input)
      return reply({ scope: workspaceId ? 'workspace' : 'personal', ...(workspaceId ? { workspaceId } : {}), secret: metadata(saved) })
    } catch (error) {
      if (error instanceof WorkspaceError) {
        if (error.code === 'secretNotFound') return reply({ error: error.code }, 404)
        if (error.code === 'workspaceAccessDenied' || error.code === 'secretPermissionDenied') return reply({ error: error.code }, 403)
        if (error.code === 'validationGeneric') return reply({ error: error.code }, 400)
      }
      // Neither database error text nor unknown codes can echo credential data.
      return reply({ error: 'secretsUnavailable' }, 503)
    }
  }
}
