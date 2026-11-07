import messages from '../../../messages/zh-CN.json'
import type { ServerProbe } from './server-discovery'

/** The app currently uses Chinese UI; both translations live with web copy.
 * Discovery errors match DesktopServer in desktop PR #1558. */
export const serverCopy = messages.MobileServer
export function probeError(probe: ServerProbe): string {
  if (probe.status === 'ok') return ''
  if (probe.status === 'server_update_required') return probe.version
    ? serverCopy.errors.serverUpdate.replace('{version}', probe.version) : serverCopy.errors.serverUpdateUnknown
  if (probe.status === 'app_update_required') return probe.minimum
    ? serverCopy.errors.appUpdate.replace('{version}', probe.minimum) : serverCopy.errors.appUpdateUnknown
  return serverCopy.errors[probe.status]
}
