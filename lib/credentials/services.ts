import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { CredentialError } from './contracts'

export type HeaderService = {
  id: string; endpoint: string; method: 'GET' | 'POST'; header: string; prefix: string
}

export function serviceFingerprint(service: HeaderService) {
  return createHash('sha256').update(JSON.stringify([service.id, service.endpoint, service.method, service.header, service.prefix])).digest('hex')
}

/** Deployment-owned exact endpoints. The browser/model cannot supply a URL, path or headers. */
export function credentialServices(input: string | undefined): ReadonlyMap<string, HeaderService> {
  const result = new Map<string, HeaderService>()
  try {
    const entries = input ? JSON.parse(input) : []
    if (!Array.isArray(entries) || entries.length > 20) throw new Error()
    for (const item of entries) {
      const url = new URL(item.endpoint)
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(item.id) || result.has(item.id) ||
        url.protocol !== 'https:' || url.username || url.password || url.hash || url.search ||
        isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || /(^|\.)(localhost|local|internal)$/.test(url.hostname) ||
        !['GET', 'POST'].includes(item.method) || !/^(Authorization|X-Api-Key)$/i.test(item.header) ||
        !['', 'Bearer '].includes(item.prefix)) throw new Error()
      result.set(item.id, Object.freeze({ id: item.id, endpoint: url.href, method: item.method, header: item.header, prefix: item.prefix }))
    }
    return result
  } catch { throw new CredentialError('service_configuration_invalid', 503) }
}

/** Never return an upstream body/header/URL/error: an upstream can echo credentials. */
export async function executeHeader(service: HeaderService, secret: string, signal: AbortSignal): Promise<{ status: number }> {
  try {
    const response = await fetch(service.endpoint, {
      method: service.method, headers: { [service.header]: `${service.prefix}${secret}` },
      redirect: 'error', cache: 'no-store', signal,
    })
    await response.body?.cancel()
    return { status: response.status }
  } catch { throw new CredentialError('credential_execution_failed', 502) }
}
