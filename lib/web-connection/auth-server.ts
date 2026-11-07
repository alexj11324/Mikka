import { sha256Hex } from '@/lib/desktop-auth-server'

/** Domain separation prevents desktop exchange from consuming a web grant, or vice versa. */
export function webAuthStateHash(state: string): string { return sha256Hex(`mikka:web-auth:v1:${state}`) }
export const webAuthHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
}
export function webBearer(request: Request): string | null {
  return /^Bearer ([^\s,]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null
}
/** A handoff is confirmed by an explicit link from the same-origin account screen. */
export function webAuthConfirmedNavigation(request: Request): boolean {
  const origin = new URL(request.url).origin
  const site = request.headers.get('sec-fetch-site')
  if (site !== null) return site === 'same-origin'
  try { return new URL(request.headers.get('referer') ?? '').origin === origin } catch { return false }
}
