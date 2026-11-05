import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'

/** Share links and daemon commands address the public service. Only installed
 * UI assets use the desktop's local scheme; web keeps its existing origin. */
export function publicAppOrigin(
  target: MikkaWindow | null | undefined = typeof window === 'undefined' ? null : window as MikkaWindow,
): string {
  if (!target) return ''
  const bridge = bridgeFromWindow(target)
  if (!bridge?.bundled) return target.location.origin
  const url = new URL(bridge.app.serverUrl)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('desktop_backend_origin_invalid')
  return url.origin
}
