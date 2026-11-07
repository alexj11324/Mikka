import { withBasePath } from '../base-path'
import { WebConnectionError } from './client'
import { selectedWebServer, webSelectionVersion } from './selection'

const objects = new Set<string>(), windows = new Set<Window>()
export function clearWebServerAssets() {
  for (const url of objects) URL.revokeObjectURL(url)
  objects.clear()
  for (const opened of windows) opened.close()
  windows.clear()
}

export function connectedAssetPath(path: string, origin: string): string {
  const value = new URL(path, origin)
  if (value.origin !== origin || value.username || value.password || value.hash
    || !value.pathname.startsWith(withBasePath('/api/'))) throw new WebConnectionError('web_connection_origin_refused')
  return value.href
}

/** Navigations cannot carry a bearer. Fetch through the selected transport and
 * return a non-executable download. Never make remote HTML an app-origin blob. */
export async function downloadServerFile(path: string): Promise<{ url: string; filename: string | null; revoke(): void }> {
  const generation = webSelectionVersion()
  const response = await fetch(connectedAssetPath(path, window.location.origin), { cache: 'no-store' })
  if (!response.ok) throw new WebConnectionError('web_connection_download_failed')
  const bytes = await response.arrayBuffer()
  if (generation !== webSelectionVersion()) throw new WebConnectionError('web_connection_session_changed')
  const filename = response.headers.get('content-disposition')?.match(/filename="([^"\r\n]+)"/)?.[1] ?? null
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  objects.add(url)
  return { url, filename, revoke: () => { URL.revokeObjectURL(url); objects.delete(url) } }
}

/** Returns false for the original cloud/native navigation. Remote HTML always
 * stays inside an opaque sandbox, including when opened in a separate window. */
export function openConnectedAsset(path: string, kind: 'download' | 'frame', download?: HTMLAnchorElement | null): Promise<void> | null {
  if (!selectedWebServer()) return null
  if (kind === 'download') return downloadServerFile(path).then(file => {
    if (!download) { file.revoke(); throw new WebConnectionError('web_connection_download_failed') }
    download.href = file.url; download.download = file.filename ?? 'artifact'; download.rel = 'noopener'
    download.click()
    // The URL is released on account change/page exit; revoking it in the same
    // turn can cancel a browser download before it consumes the response.
  })
  const opened = window.open('about:blank', '_blank')
  if (!opened) return Promise.reject(new WebConnectionError('web_connection_popup_blocked'))
  opened.opener = null
  windows.add(opened)
  const generation = webSelectionVersion()
  return fetch(connectedAssetPath(path, window.location.origin), { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new WebConnectionError('web_connection_download_failed')
    const html = await response.text()
    if (generation !== webSelectionVersion() || opened.closed) throw new WebConnectionError('web_connection_session_changed')
    const frame = opened.document.createElement('iframe')
    frame.sandbox.add('allow-scripts', 'allow-popups')
    frame.referrerPolicy = 'no-referrer'
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0'
    frame.srcdoc = html
    opened.document.body.replaceChildren(frame)
  }).catch(error => { opened.close(); windows.delete(opened); throw error })
}
