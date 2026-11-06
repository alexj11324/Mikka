import { withBasePath } from '@/lib/base-path'
import { ComputerRequestError } from './request-error'

/** Transport-only seam. Desktop substitutes its main-owned viewer relay while
 * the web keeps the existing endpoint, response and error behavior. */
export async function computerRequest<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const response = await fetch(withBasePath(path), {
    credentials: 'same-origin',
    ...init,
    headers: init?.json === undefined ? init?.headers : { 'content-type': 'application/json', ...init.headers },
    body: init?.json === undefined ? init?.body : JSON.stringify(init.json),
  })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new ComputerRequestError(response.status, body)
  return body as T
}
