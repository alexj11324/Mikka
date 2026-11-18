/**
 * Vercel's deployment protection is an edge-specific bypass; it is not the
 * worker's authentication. Every daemon request still uses the short-lived
 * per-device bearer credential. For other HTTPS preview hosts, omit this
 * header and rely on the application's device authentication.
 */
export function vercelPreviewProtectionBypass(server: string, env: Record<string, string | undefined> = process.env) {
  if (env.VERCEL_ENV !== 'preview') return undefined
  const url = new URL(server)
  if (!url.hostname.endsWith('.vercel.app')) return undefined
  const bypass = env.MIKKA_CLOUD_PREVIEW_BYPASS
  if (!bypass) return undefined
  if (url.protocol !== 'https:' || !/^[A-Za-z0-9_-]{20,256}$/.test(bypass)) throw new Error('Invalid cloud worker configuration')
  return bypass
}
