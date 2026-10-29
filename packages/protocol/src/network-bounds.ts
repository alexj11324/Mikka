/** Host policy domain algebra, never a model classifier. An omitted port covers
 * all ports; *.example.com covers subdomains, not the apex. */
type Domain = { host: string; port?: string; wildcard: boolean }
function parse(value: string): Domain | null {
  if (value === '*') return { host: '*', wildcard: false }
  const match = /^(\*\.)?([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/.exec(value.toLowerCase())
  if (!match || match[3] && Number(match[3]) > 65535 || match[2].includes('..')) return null
  return { host: match[2], wildcard: Boolean(match[1]), ...(match[3] ? {port:match[3]} : {}) }
}
function includesHost(outer: Domain, inner: Domain): boolean {
  if (outer.host === '*') return true
  if (inner.host === '*') return false
  if (!outer.wildcard) return !inner.wildcard && outer.host === inner.host
  return inner.host.endsWith(`.${outer.host}`) || inner.wildcard && inner.host === outer.host
}
export function intersectNetworkDomains(left: readonly string[], right: readonly string[]): string[] {
  const result = new Set<string>()
  for (const l of left) for (const r of right) {
    const a=parse(l), b=parse(r)
    if (!a || !b || a.port && b.port && a.port !== b.port) continue
    const narrow=includesHost(a,b) ? b : includesHost(b,a) ? a : null
    if (!narrow) continue
    const port=a.port ?? b.port
    result.add(`${narrow.wildcard ? '*.' : ''}${narrow.host}${port ? ':'+port : ''}`)
  }
  return [...result]
}
export function networkDomainsWithin(next: readonly string[], maximum: readonly string[]): boolean {
  return next.every(value => intersectNetworkDomains([value],maximum).includes(value.toLowerCase()))
}
