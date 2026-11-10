import { mobileMessages as messages } from './messages'
import type { ServerProbe } from './server-discovery'

/** Discovery errors share DesktopServer's account and version terminology. */
export const serverCopy = messages.MobileServer
export function probeError(probe: ServerProbe): string {
  if (probe.status === 'ok') return ''
  if (probe.status === 'server_update_required') return probe.version
    ? serverCopy.errors.serverUpdate.replace('{version}', probe.version) : serverCopy.errors.serverUpdateUnknown
  if (probe.status === 'app_update_required') return probe.minimum
    ? serverCopy.errors.appUpdate.replace('{version}', probe.minimum) : serverCopy.errors.appUpdateUnknown
  return serverCopy.errors[probe.status]
}
