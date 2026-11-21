import { withBasePath } from '../base-path'

export class RequestError extends Error {
  constructor(readonly code: string, readonly status: number, readonly body: Record<string, unknown>) { super(code) }
}

export async function request(path: string, body?: unknown, headers?: Record<string, string>) {
  const response = await fetch(withBasePath(path), body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const value = await response.json().catch(() => ({}))
  if (response.status === 202) return { ...value, deferred: true }
  if (!response.ok) throw new RequestError(value.error ?? 'factoryUnavailable', response.status, value)
  return value
}
