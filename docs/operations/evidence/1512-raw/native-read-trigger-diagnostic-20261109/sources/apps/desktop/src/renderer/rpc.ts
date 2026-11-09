import { capturePendingReadDispatch, captureReadDispatch } from '@/lib/swr/read-observer'
import { observeReadDiagnostic } from '@/lib/swr/read-diagnostics'
import { withBasePath } from '@/lib/base-path'
import { decode, encodeArgs, DESKTOP_RPC_VERSION } from '@/lib/desktop-rpc/wire'
import { isBatchReadAction } from '@/lib/desktop-rpc/read-batch-contract'
import { localeOf, type Locale } from './location'
import { setTransportState } from './transport-state'
import { DesktopTransportError, enqueueRead, isSnapshotReadAction } from './read-batch'

export { DesktopTransportError, resetReadBatchScope } from './read-batch'

const nativeTransport = { endpoint: '/api/desktop/rpc', credentials: 'omit', header: 'x-mikka-desktop-protocol' } as const
const workspaceSelector = () => new URLSearchParams(window.location.search).get('workspace')

/** The renderer has no auth headers. Electron's scheme handler supplies them in
 * main, so even a compromised page cannot read or export its session credential. */
export function callAction<T = unknown>(action: string, args: unknown[], isCurrent?: () => boolean): Promise<T> {
  if (!isBatchReadAction(action)) return callRemoteAction(action, args, { ...nativeTransport, isCurrent })
  const onDispatch = isSnapshotReadAction(action) ? capturePendingReadDispatch() : undefined
  return enqueueRead(action, args, {
    locale: localeOf(window.location.pathname), workspace: workspaceSelector(), currentWorkspace: workspaceSelector, isCurrent,
    ...(onDispatch ? { onDispatch } : {}),
  }, (action, args, context) => callRemoteAction(action, args, { ...nativeTransport, ...context }))
}

export async function callRemoteAction<T = unknown>(action: string, args: unknown[], transport: { endpoint: '/api/desktop/rpc' | '/api/rpc'; credentials: 'omit' | 'same-origin'; header: 'x-mikka-desktop-protocol' | 'x-mikka-rpc'; isCurrent?: (response?: Response) => boolean; locale?: Locale; onDispatch?: () => void; diagnosticItems?: readonly object[]; diagnosticActions?: readonly string[] }): Promise<T> {
  // Web supplies its existing SDK owner generation; bootstrap also fences
  // retired page phases. Native identity authorization remains in main.
  const assertCurrent = (cause?: unknown, response?: Response) => {
    if (transport.isCurrent?.(response) === false) throw new DesktopTransportError('desktop_session_changed', { status: 409, cause })
  }
  const encoded = await encodeArgs(args)
  assertCurrent()
  let response: Response
  // Only this snapshot read (or its batch envelope) supplies a dispatch proof.
  // Other list actions may merge cached data or issue additional reads.
  const prove = transport.endpoint === '/api/desktop/rpc' && (isSnapshotReadAction(action) || action === 'desktop.readBatch') ? captureReadDispatch() : undefined
  // A pending snapshot may cover the live gap before its response arrives.
  // Completion still requires that response's existing dispatch proof.
  if (prove) transport.onDispatch?.()
  const diagnosticRequest = {}
  observeReadDiagnostic('rpc_dispatch', { request: diagnosticRequest, action, actions: transport.diagnosticActions, proof: prove !== undefined })
  for (let index = 0; index < (transport.diagnosticItems?.length ?? 0); index++) observeReadDiagnostic('rpc_dispatch', { request: diagnosticRequest, item: transport.diagnosticItems![index], action: transport.diagnosticActions?.[index] })
  try {
    response = await fetch(withBasePath(transport.endpoint), {
      method: 'POST',
      cache: 'no-store',
      credentials: transport.credentials,
      headers: { 'content-type': 'application/json', [transport.header]: String(DESKTOP_RPC_VERSION), 'x-mikka-locale': transport.locale ?? localeOf(window.location.pathname) },
      body: JSON.stringify({ version: DESKTOP_RPC_VERSION, action, args: encoded }),
    })
  } catch (cause) {
    observeReadDiagnostic('rpc_failed', { request: diagnosticRequest, action })
    assertCurrent(cause)
    setTransportState('offline')
    throw new DesktopTransportError('desktop_backend_unreachable', { cause })
  }
  observeReadDiagnostic('rpc_headers', { request: diagnosticRequest, action })
  assertCurrent(undefined, response)
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
  assertCurrent(undefined, response)
  if (!value || value.version !== DESKTOP_RPC_VERSION || typeof value.ok !== 'boolean') throw new DesktopTransportError('desktop_rpc_response_invalid', { status: response.status })
  if (!value.ok) throw new DesktopTransportError(value.error?.code ?? 'desktop_rpc_response_invalid', { status: response.status })
  if (!response.ok) throw new DesktopTransportError('desktop_rpc_request_rejected', { status: response.status })
  setTransportState('ready')
  const result = decode(value.result) as T
  observeReadDiagnostic('rpc_decoded', { request: diagnosticRequest, action, proof: prove !== undefined })
  return prove ? prove(result) : result
}
