import { callRemoteAction } from '../../../desktop/src/renderer/rpc'
export { DesktopTransportError } from '../../../desktop/src/renderer/rpc'

/** Browser cookies and CSRF stay on the independent web entry. No desktop
 * bearer, cache proof or token-rotation header is available in this runtime. */
export function callAction<T = unknown>(action: string, args: unknown[]): Promise<T> {
  return callRemoteAction(action, args, { endpoint: '/api/rpc', credentials: 'same-origin', header: 'x-mikka-rpc' })
}
