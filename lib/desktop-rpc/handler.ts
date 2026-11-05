import { z } from 'zod'
import { decode, encode, DESKTOP_RPC_VERSION, DESKTOP_RPC_PREVIOUS_VERSION, UPDATE_REQUIRED } from './wire'

export type DesktopAction = { args: z.ZodType; invoke: (args: never[]) => Promise<unknown> }
export type DesktopActions = Readonly<Record<string, DesktopAction>>
const requestSchema = z.object({ version: z.number().int(), action: z.string().min(1).max(120), args: z.unknown() }).strict()
const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json', Vary: 'Authorization' }
const maxBytes = 4 * 1024 * 1024

function failure(status: number, code: string, version: number = DESKTOP_RPC_VERSION) {
  return Response.json({ version, ok: false, error: { code } }, { status, headers: noStore })
}

/** Authentication never sees ambient cookies. The separate native cache header
 * must still pass Better Auth's signature, bearer-binding and expiry checks. */
export function desktopBearerHeaders(request: Request): Headers | null {
  const authorization = request.headers.get('authorization')
  if (!authorization || !/^Bearer [A-Za-z0-9_.%~+/-]{32,512}$/.test(authorization) || /^Bearer (?:mkp_|mka_|mkr_)/.test(authorization)) return null
  const headers = new Headers(request.headers)
  headers.delete('cookie')
  return headers
}

/** Headers for an existing human-only REST handler. Its original freshness
 * policy still applies. This rules out delegated credentials and prevents a
 * browser cookie from rescuing an invalid token. */
export function humanSessionHeaders(request: Request): Headers | null {
  return request.headers.has('authorization') ? desktopBearerHeaders(request) : request.headers.get('cookie') ? request.headers : null
}

async function body(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > maxBytes) return null
  if (!request.body) return null
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maxBytes) { await reader.cancel(); return null }
      parts.push(part.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch { return null }
}

/** The transport calls only this closed registry; it never imports a caller
 * supplied module or uses Next's deploy-specific Server Action identifiers. */
export function createDesktopRpc<Session>(options: {
  authenticate: (headers: Headers) => Promise<Session | null>
  scope: (session: Session, work: () => Promise<Response>, request: Request) => Promise<Response>
  actions: DesktopActions
  error?: (error: unknown) => { status: number; code: string }
}) {
  return async (request: Request): Promise<Response> => {
    const headers = desktopBearerHeaders(request)
    if (!headers) return failure(401, 'desktop_session_expired')
    let session: Session | null
    try { session = await options.authenticate(headers) } catch { return failure(503, 'desktop_rpc_failed') }
    if (!session) return failure(401, 'desktop_session_expired')
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return failure(415, 'desktop_rpc_request_invalid')
    const parsed = requestSchema.safeParse(await body(request))
    if (!parsed.success) return failure(400, 'desktop_rpc_request_invalid')
    const input = parsed.data
    const headerVersion = request.headers.get('x-mikka-desktop-protocol')
    if (![DESKTOP_RPC_VERSION, DESKTOP_RPC_PREVIOUS_VERSION].includes(input.version as 0 | 1)
      || (headerVersion !== null && headerVersion !== String(input.version))) return failure(426, UPDATE_REQUIRED)
    if (!Object.hasOwn(options.actions, input.action)) return failure(404, 'desktop_rpc_action_unknown', input.version)
    const action = options.actions[input.action]
    let args: unknown
    try { args = decode(input.args) } catch { return failure(400, 'desktop_rpc_request_invalid', input.version) }
    const validated = action.args.safeParse(args)
    if (!validated.success || !Array.isArray(validated.data)) return failure(400, 'desktop_rpc_request_invalid', input.version)
    return options.scope(session, async () => {
      try {
        const result = await action.invoke(validated.data as never[])
        return Response.json({ version: input.version, ok: true, result: encode(result) }, { headers: noStore })
      } catch (error) {
        const response = options.error?.(error) ?? { status: 500, code: 'desktop_rpc_failed' }
        return failure(response.status, response.code, input.version)
      }
    }, request)
  }
}
