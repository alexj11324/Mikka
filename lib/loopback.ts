const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** A loopback host as `URL.hostname` gives it (`[::1]`), or with the IPv6 brackets stripped (`::1`). */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname)
}
