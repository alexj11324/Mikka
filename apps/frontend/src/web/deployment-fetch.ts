import { withBasePath } from '@/lib/base-path'

const installed = Symbol.for('mikka.web.deployment-fetch')

/** Pin browser API calls to the HTML's deployment. The public version check
 * deliberately bypasses that pin so the existing VersionGuard sees updates. */
export function installDeploymentFetch(target: Window, deploymentId = process.env.MIKKA_DEPLOYMENT_ID ?? '') {
  const state = target as Window & { [installed]?: true }
  if (!deploymentId || state[installed]) return
  state[installed] = true
  const original = target.fetch.bind(target)
  target.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, target.location.href)
    const ownApi = url.origin === target.location.origin && url.pathname.startsWith(withBasePath('/api/'))
    if (!ownApi || url.pathname === withBasePath('/api/version')) return original(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set('x-deployment-id', deploymentId)
    return original(input, { ...init, headers })
  }
}
