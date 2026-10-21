export function safeAuthReturn(value?: string) {
  if (value && (/^\/invite\/[a-f0-9]{64}$/.test(value) || value === '/settings/members')) return value
  return '/'
}
