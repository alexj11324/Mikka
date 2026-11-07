import { CloudServiceError } from './errors'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
export const DEFAULT_CLOUD_URL = 'https://app.aspectlylabs.com/mikka/cloud'
/** Configuration is operator-owned; requests cannot supply a cloud endpoint. */
export function cloudServiceUrl(env: Record<string, string | undefined> = process.env): string {
  try {
    const url = new URL(env.MIKKA_CLOUD_URL || DEFAULT_CLOUD_URL)
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) throw new CloudServiceError('cloud_invalid_request', 'configuration')
    return url.href.replace(/\/$/, '')
  } catch (error) { if (error instanceof CloudServiceError) throw error; throw new CloudServiceError('cloud_invalid_request', 'configuration', error) }
}

export function selfHostedAddress(env: Record<string, string | undefined> = process.env) {
  try {
    const url = new URL(env.BETTER_AUTH_URL ?? '')
    const basePath = env.MIKKA_BASE_PATH ?? '/mikka'
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
      || (basePath !== '' && !/^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*$/.test(basePath))) throw new CloudServiceError('cloud_invalid_request', 'configuration')
    return { origin: url.origin, basePath, redirectUri: `${url.origin}${basePath}/api/cloud/callback` }
  } catch (error) { if (error instanceof CloudServiceError) throw error; throw new CloudServiceError('cloud_invalid_request', 'configuration', error) }
}

export function cloudEndpoint(serviceUrl: string, path: string): string {
  if (!/^\/(?:[A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._-]+)*$/.test(path) || path.split('/').includes('..')) throw new CloudServiceError('cloud_invalid_request', 'protocol')
  return `${serviceUrl}${path}`
}
