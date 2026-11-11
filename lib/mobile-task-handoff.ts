import { canonicalWebServer } from './web-connection/policy'
import { mobileWebTarget } from './mobile-web-target'

const reference = /^[A-Za-z0-9_-]{43}$/

/** A navigation reference carries no account authority or entity coordinates. */
export const isTaskReference = (value: unknown): value is string => typeof value === 'string' && reference.test(value)

export function mobileTaskTarget(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/?issue=') || mobileWebTarget(value) !== value) return null
  return value
}

export function mobileTaskLaunch(location: URL) {
  if (location.search || !location.hash.startsWith('#mobileTask=')) return null
  const params = new URLSearchParams(location.hash.slice(1))
  const ref = params.get('mobileTask'), server = canonicalWebServer(params.get('server'))
  return params.size === 2 && isTaskReference(ref) && server ? { ref, server } : null
}
