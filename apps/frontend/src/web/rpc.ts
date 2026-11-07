import { callRemoteAction } from '../../../desktop/src/renderer/rpc'
import { getSessionOwnerVersion } from './session-owner'
export { DesktopTransportError } from '../../../desktop/src/renderer/rpc'

/** Browser cookies and CSRF stay on the independent web entry. No desktop
 * bearer, cache proof or token-rotation header is available in this runtime. */
export function callAction<T = unknown>(action: string, args: unknown[], isCurrent?: () => boolean): Promise<T> {
  const version = getSessionOwnerVersion()
  return callRemoteAction(action, args, {
    endpoint: '/api/rpc', credentials: 'same-origin', header: 'x-mikka-rpc',
    isCurrent: () => getSessionOwnerVersion() === version && isCurrent?.() !== false,
  })
}
