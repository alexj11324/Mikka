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
export function callAction<T = unknown>(action: string, args: unknown[], isCurrent?: () => boolean): Promise<T> {
  return callRemoteAction(action, args, { endpoint: '/api/desktop/rpc', credentials: 'omit', header: 'x-mikka-desktop-protocol', isCurrent })
}

export async function callRemoteAction<T = unknown>(action: string, args: unknown[], transport: { endpoint: '/api/desktop/rpc' | '/api/rpc'; credentials: 'omit' | 'same-origin'; header: 'x-mikka-desktop-protocol' | 'x-mikka-rpc'; isCurrent?: () => boolean }): Promise<T> {
  // Web supplies its existing SDK owner generation; bootstrap also fences
  // retired page phases. Native identity authorization remains in main.
  const assertCurrent = (cause?: unknown) => {
    if (transport.isCurrent?.() === false) throw new DesktopTransportError('desktop_session_changed', { status: 409, cause })
  }
  const encoded = await encodeArgs(args)
  assertCurrent()
  let response: Response
  try {
    response = await fetch(withBasePath(transport.endpoint), {
      method: 'POST',
      cache: 'no-store',
      credentials: transport.credentials,
      headers: { 'content-type': 'application/json', [transport.header]: String(DESKTOP_RPC_VERSION), 'x-mikka-locale': localeOf(window.location.pathname) },
      body: JSON.stringify({ version: DESKTOP_RPC_VERSION, action, args: encoded }),
    })
  } catch (cause) {
    assertCurrent(cause)
    setTransportState('offline')
    throw new DesktopTransportError('desktop_backend_unreachable', { cause })
  }
  assertCurrent()
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
  assertCurrent()
  if (!value || value.version !== DESKTOP_RPC_VERSION || typeof value.ok !== 'boolean') throw new DesktopTransportError('desktop_rpc_response_invalid', { status: response.status })
  if (!value.ok) throw new DesktopTransportError(value.error?.code ?? 'desktop_rpc_response_invalid', { status: response.status })
  if (!response.ok) throw new DesktopTransportError('desktop_rpc_request_rejected', { status: response.status })
  setTransportState('ready')
  return decode(value.result) as T
}
