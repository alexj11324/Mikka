/**
 * A Mikka server endpoint the daemon may send a run's token to: https, or
 * http only on loopback, and no credentials, query or fragment.
 */
export function trustedServerEndpoint(url: URL): boolean {
  if (url.username || url.password || url.search || url.hash) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
}
