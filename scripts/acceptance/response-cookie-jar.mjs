/** A fresh, memory-only cookie jar per acceptance run. Preserve cookies set during page discovery for subsequent requests. */
export function responseCookieJar(now) {
  const cookies = new Map()
  const domainMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`)
  return {
    receive(url, headers) {
      for (const header of headers.getSetCookie()) {
        const parts = header.split(';').map(value => value.trim()), separator = parts[0].indexOf('=')
        if (separator < 1) continue
        const name = parts[0].slice(0, separator), value = parts[0].slice(separator + 1)
        if (!/^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/.test(name)) continue
        const attributes = Object.fromEntries(parts.slice(1).map(part => {
          const at = part.indexOf('=')
          return at < 0 ? [part.toLowerCase(), true] : [part.slice(0, at).toLowerCase(), part.slice(at + 1)]
        }))
        const domain = typeof attributes.domain === 'string' ? attributes.domain.replace(/^\./, '').toLowerCase() : url.hostname
        if (!domain || !domainMatches(url.hostname, domain)) continue
        const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/'
        const path = typeof attributes.path === 'string' && attributes.path.startsWith('/') ? attributes.path : defaultPath
        const maxAge = /^-?\d+$/.test(attributes['max-age'] ?? '') ? Number(attributes['max-age']) : NaN
        const expires = Number.isFinite(maxAge) ? now() + maxAge * 1000 : Date.parse(attributes.expires)
        const key = JSON.stringify([name, domain, path])
        if (expires <= now()) cookies.delete(key)
        else cookies.set(key, { name, value, domain, path, expires, secure: Boolean(attributes.secure) })
      }
    },
    header(url) {
      for (const [key, cookie] of cookies) if (cookie.expires <= now()) cookies.delete(key)
      return [...cookies.values()].filter(cookie => domainMatches(url.hostname, cookie.domain)
        && (!cookie.secure || url.protocol === 'https:')
        && (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)))
        .sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    },
    clear() { cookies.clear() },
  }
}
