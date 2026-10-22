export function safeAuthReturn(value?: string) {
  if (!value) return '/'
  if (/^\/invite\/[a-f0-9]{64}$/.test(value)) return value
  if (value === '/settings/members' || value === '/devices' || value === '/?settings=devices') return value
  // A deep link to one issue is the only query form accepted, so `next`
  // cannot be used as an open redirect.
  if (/^\/\?issue=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value
  return '/'
}
