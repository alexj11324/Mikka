import { callRemoteAction } from '../../../desktop/src/renderer/rpc'
import { getSessionOwnerVersion } from './session-owner'
import { currentWebServers } from '@/lib/web-connection/browser'
export { DesktopTransportError } from '../../../desktop/src/renderer/rpc'

/** Browser cookies and CSRF stay on the independent web entry. No desktop
 * bearer, cache proof or token-rotation header is available in this runtime. */
export function callAction<T = unknown>(action: string, args: unknown[], isCurrent?: () => boolean): Promise<T> {
  const version = getSessionOwnerVersion()
  const servers = currentWebServers(), serverVersion = servers?.getVersion()
  const workspaceVersion = servers?.getWorkspaceVersion()
  return callRemoteAction(action, args, {
    endpoint: '/api/rpc', credentials: 'same-origin', header: 'x-mikka-rpc',
    isCurrent: response => getSessionOwnerVersion() === version && servers?.getVersion() === serverVersion
      && isCurrent?.() !== false
      && (response ? !servers || servers.isCurrentResponse(response) : servers?.getWorkspaceVersion() === workspaceVersion),
  })
}
