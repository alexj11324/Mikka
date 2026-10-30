/**
 * A link that is safe to put in an href. Anything that is not http(s) —
 * `javascript:`, `data:`, relative tricks — is refused, because these URLs
 * come from outside (reminder sources, action targets) and land in the DOM.
 */
export function httpUrl(raw: string | null | undefined, base?: string): string | null {
  if (!raw) return null
  try {
    const url = base ? new URL(raw, base) : new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}
