/** Credential and egress are both restricted to the Container's private
 * intercept. Redirects must never carry the capability to another origin. */
export function createBoundFetch(capability, transport = globalThis.fetch) {
  if (typeof capability !== 'string' || !capability) throw new Error('Private World capability unavailable')
  return (input, init = {}) => {
    const url = new URL(input)
    if (url.origin !== 'https://world.internal' || url.username || url.password) {
      throw new TypeError('Invalid private World origin')
    }
    const headers = new Headers(init.headers)
    headers.set('x-mikka-world-capability', capability)
    return transport(url, { ...init, headers, redirect: 'error' })
  }
}
