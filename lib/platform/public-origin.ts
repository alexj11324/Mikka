import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { bridgeFromWindow, type MikkaWindow } from '@/lib/platform/detect'
import { selectedWebServer } from '@/lib/web-connection/selection'

/** Addresses for people and devices belong to the installation serving the data. */
export function publicServiceAddress(
  target: MikkaWindow | null | undefined = typeof window === 'undefined' ? null : window as MikkaWindow,
): { origin: string; basePath: string } {
  if (!target) return { origin: '', basePath: BASE_PATH }
  const bridge = bridgeFromWindow(target)
  const configured = bridge?.bundled ? bridge.app.serverUrl : selectedWebServer()
  if (!configured) return { origin: target.location.origin, basePath: BASE_PATH }
  const url = new URL(configured)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('desktop_backend_origin_invalid')
  return { origin: url.origin, basePath: url.pathname.replace(/\/$/, '') }
}

export function publicAppOrigin(target?: MikkaWindow | null): string {
  return publicServiceAddress(target).origin
}

export function publicServiceLink(path: string, target?: MikkaWindow | null): string {
  const { origin, basePath } = publicServiceAddress(target)
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('invalid_service_link')
  const url = new URL(withBasePath(path, basePath), origin)
  if (url.origin !== origin || (basePath && url.pathname !== basePath && !url.pathname.startsWith(basePath + '/'))) throw new Error('invalid_service_link')
  return url.href
}
