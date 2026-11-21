// A release pin identifies the route or file, but the private service receives
// the original URL. Decode only RFC 3986 unreserved characters for comparison.
export function releaseRoutePath(pathname) {
  if (!pathname.includes('%')) return pathname
  try { decodeURIComponent(pathname) } catch { return pathname }
  return pathname.replace(/%([a-f0-9]{2})/gi, (escape, hex) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16))
    return /[a-z0-9._~-]/i.test(char) ? char : escape
  })
}

export const versionPath = '/mikka/api/version'
