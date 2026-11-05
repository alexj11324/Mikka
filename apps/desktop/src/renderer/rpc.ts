import { withBasePath } from '@/lib/base-path'
import { decode, encodeArgs, DESKTOP_RPC_VERSION } from '@/lib/desktop-rpc/wire'
import { localeOf } from './location'
import { setTransportState } from './transport-state'

export class DesktopTransportError extends Error {
  readonly status?: number
  constructor(readonly code: string, options?: ErrorOptions & { status?: number }) {
    super(code, options)
    this.name = 'DesktopTransportError'
    this.status = options?.status
  }
}

/** The renderer has no auth headers. Electron's scheme handler supplies them in
 * main, so even a compromised page cannot read or export its session credential. */
export async function callAction<T = unknown>(action: string, args: unknown[]): Promise<T> {
  const encoded = await encodeArgs(args)
  let response: Response
  try {
    response = await fetch(withBasePath('/api/desktop/rpc'), {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'content-type': 'application/json', 'x-mikka-desktop-protocol': String(DESKTOP_RPC_VERSION), 'x-mikka-locale': localeOf(window.location.pathname) },
      body: JSON.stringify({ version: DESKTOP_RPC_VERSION, action, args: encoded }),
    })
  } catch (cause) {
    setTransportState('offline')
    throw new DesktopTransportError('desktop_backend_unreachable', { cause })
  }
  if (response.status === 401) {
    setTransportState('unauthenticated')
    throw new DesktopTransportError('desktop_session_expired', { status: response.status })
  }
  if (response.status === 426) {
    setTransportState('update-required')
    throw new DesktopTransportError('desktop_client_update_required', { status: response.status })
  }
  if (response.status >= 502 && response.status <= 504) {
    setTransportState('offline')
    throw new DesktopTransportError('desktop_backend_unreachable', { status: response.status })
  }
  const value = await response.json().catch(() => null) as { version: number; ok: boolean; result?: unknown; error?: { code: string } } | null
  if (!value || value.version !== DESKTOP_RPC_VERSION || typeof value.ok !== 'boolean') throw new DesktopTransportError('desktop_rpc_response_invalid', { status: response.status })
  if (!value.ok) throw new DesktopTransportError(value.error?.code ?? 'desktop_rpc_response_invalid', { status: response.status })
  if (!response.ok) throw new DesktopTransportError('desktop_rpc_request_rejected', { status: response.status })
  setTransportState('ready')
  return decode(value.result) as T
}
