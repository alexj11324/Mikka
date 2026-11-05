import { ComputerRequestError } from '@/lib/computer/request-error'
import { computerRequest as webRequest } from '@/lib/computer/request'
import { rendererHost } from './host'

/** The renderer receives an owner-bound local handle, never a remote VNC
 * grant. All other computer requests keep the shared HTTP implementation. */
export async function computerRequest<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const viewer = /^\/api\/bots\/([^/]+)\/computer\/(viewer|takeover)$/.exec(path)
  if (!viewer || init?.method !== 'POST') return webRequest<T>(path, init)
  const requested = init.json as { mode?: unknown } | undefined
  const mode = viewer[2] === 'takeover' ? 'control' : requested?.mode
  if (mode !== 'view' && mode !== 'control') throw new ComputerRequestError(400, { error: 'invalid_request' })
  const response = await rendererHost().viewer.prepare({ botId: decodeURIComponent(viewer[1]), mode, ...(viewer[2] === 'takeover' ? { takeover: true } : {}) })
  if (response.status < 200 || response.status >= 300) throw new ComputerRequestError(response.status, response.body)
  return response.body as T
}
