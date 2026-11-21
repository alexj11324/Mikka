// The private service binding carries the original URL. Construct proxy
// authority from the configured public origin, never from a caller header.
export function apiRequest(request, origin) {
  const url = new URL(request.url)
  if (url.origin !== origin || url.protocol !== 'https:') return null
  const outbound = new Request(request, { redirect: 'manual' })
  const ip = outbound.headers.get('cf-connecting-ip')
  for (const key of request.headers.keys()) {
    if (key === 'x-mikka-eve-scope' || key === 'x-mikka-eve-binding-scope' || key === 'forwarded' || key === 'x-real-ip' || key === 'cf-connecting-ip'
      || key === 'cf-container-target-port' || key.startsWith('x-forwarded-')
      || key.startsWith('x-vercel-') || key.startsWith('x-mikka-edge-')) outbound.headers.delete(key)
  }
  outbound.headers.set('host', url.host)
  outbound.headers.set('x-forwarded-host', url.host)
  outbound.headers.set('x-forwarded-proto', 'https')
  if (ip) outbound.headers.set('x-mikka-edge-ip', ip)
  return outbound
}
