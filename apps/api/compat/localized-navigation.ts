import { redirect as navigate, permanentRedirect as permanent } from './navigation'

type Href = string | { pathname: string; query?: Record<string, string | number | boolean | null | undefined | Array<string | number | boolean>>; hash?: string }
export function getPathname({ href, locale }: { href: Href; locale: string; forcePrefix?: boolean }): string {
  const path = typeof href === 'string' ? href : href.pathname
  if (!path.startsWith('/') || path.startsWith('//')) return path
  const target = new URL(path, 'https://mikka.invalid')
  if (typeof href !== 'string') {
    for (const [key, value] of Object.entries(href.query ?? {})) {
      if (value == null) continue
      for (const item of Array.isArray(value) ? value : [value]) target.searchParams.append(key, String(item))
    }
    if (href.hash !== undefined) target.hash = href.hash
  }
  const prefix = locale === 'en' ? '/en' : ''
  return `${prefix}${target.pathname === '/' && prefix ? '' : target.pathname}${target.search}${target.hash}`
}
export function redirect(input: { href: Href; locale: string }, type?: 'push' | 'replace'): never { return navigate(getPathname(input), type) }
export function permanentRedirect(input: { href: Href; locale: string }, type?: 'push' | 'replace'): never { return permanent(getPathname(input), type) }
