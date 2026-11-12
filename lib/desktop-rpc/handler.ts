import { z } from 'zod'
import { noteLogRpcAction } from '../request-log'
import { decode, encode, DESKTOP_RPC_VERSION, DESKTOP_RPC_PREVIOUS_VERSION, UPDATE_REQUIRED } from './wire'
import { desktopSameOriginRequest } from '../desktop-auth'

export type DesktopAction = { args: z.ZodType; invoke: (args: never[]) => Promise<unknown> }
export type DesktopActions = Readonly<Record<string, DesktopAction>>
const requestSchema = z.object({ version: z.number().int(), action: z.string().min(1).max(120), args: z.unknown() }).strict()
const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json', Vary: 'Authorization' }
const maxBytes = 4 * 1024 * 1024

export function rpcFailure(status: number, code: string, version: number = DESKTOP_RPC_VERSION, vary = 'Authorization') {
  return Response.json({ version, ok: false, error: { code } }, { status, headers: { ...noStore, Vary: vary } })
}
const failure = rpcFailure

/** Authentication never sees ambient cookies. The separate native cache header
 * must still pass Better Auth's signature, bearer-binding and expiry checks. */
export function desktopBearerHeaders(request: Request): Headers | null {
  const authorization = request.headers.get('authorization')
  // Better Auth's set-auth-token is a signed value with base64 padding.
  // Only trailing padding is allowed; the complete token stays within 512 bytes.
  if (!authorization || !/^Bearer (?=.{32,512}$)[A-Za-z0-9_.%~+/-]+={0,2}$/.test(authorization) || /^Bearer (?:mkp_|mka_|mkr_|mksvc_)/.test(authorization)) return null
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
export type RpcDispatchOptions<Session> = {
  scope: (session: Session, work: () => Promise<Response>, request: Request) => Promise<Response>
  actions: DesktopActions
  error?: (error: unknown) => { status: number; code: string }
}

/** The browser and native transports share parameter/return validation, not
 * credentials. Each transport authenticates and installs its own scope first. */
export async function dispatchRpc<Session>(options: RpcDispatchOptions<Session>, request: Request, session: Session, vary = 'Authorization'): Promise<Response> {
    const failure = (status: number, code: string, version?: number) => rpcFailure(status, code, version, vary)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return failure(415, 'desktop_rpc_request_invalid')
    const parsed = requestSchema.safeParse(await body(request))
    if (!parsed.success) return failure(400, 'desktop_rpc_request_invalid')
    const input = parsed.data
    const headerVersion = request.headers.get('x-mikka-desktop-protocol')
    if (![DESKTOP_RPC_VERSION, DESKTOP_RPC_PREVIOUS_VERSION].includes(input.version as 0 | 1)
      || (headerVersion !== null && headerVersion !== String(input.version))) return failure(426, UPDATE_REQUIRED)
    if (!Object.hasOwn(options.actions, input.action)) return failure(404, 'desktop_rpc_action_unknown', input.version)
    noteLogRpcAction(input.action)
    const action = options.actions[input.action]
    let args: unknown
    try { args = decode(input.args) } catch { return failure(400, 'desktop_rpc_request_invalid', input.version) }
    const validated = action.args.safeParse(args)
    if (!validated.success || !Array.isArray(validated.data)) return failure(400, 'desktop_rpc_request_invalid', input.version)
    return options.scope(session, async () => {
      try {
        const result = await action.invoke(validated.data as never[])
        return Response.json({ version: input.version, ok: true, result: encode(result) }, { headers: { ...noStore, Vary: vary } })
      } catch (error) {
        const response = options.error?.(error) ?? { status: 500, code: 'desktop_rpc_failed' }
        return failure(response.status, response.code, input.version)
      }
    }, request)
}

export function createDesktopRpc<Session>(options: RpcDispatchOptions<Session> & {
  authenticate: (headers: Headers) => Promise<Session | null>
}) {
  return async (request: Request): Promise<Response> => {
    if (!desktopSameOriginRequest(request)) return failure(403, 'desktop_rpc_request_invalid')
    const headers = desktopBearerHeaders(request)
    if (!headers) return failure(401, 'desktop_session_expired')
    let session: Session | null
    try { session = await options.authenticate(headers) } catch { return failure(503, 'desktop_rpc_failed') }
    if (!session) return failure(401, 'desktop_session_expired')
    return dispatchRpc(options, request, session)
  }
}
