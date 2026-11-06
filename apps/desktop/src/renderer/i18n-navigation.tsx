import { forwardRef, useMemo } from 'react'
import { useLocale } from 'next-intl'
import { BASE_PATH } from '@/lib/base-path'
import { routing } from '@/i18n/routing'
import NextLink, { type LinkProps } from './next-link'
import { localeHref, navigate, refresh, useLocation, withoutLocale, type Href } from './location'

export const usePathname = () => withoutLocale(useLocation().pathname)
export const getPathname = ({ href, locale }: { href: Href; locale: string }) => localeHref(href, locale)
export const redirect = ({ href, locale }: { href: Href; locale: string }) => navigate(href, true, { locale }, true)

/** Preserve next-intl's explicit locale-switch cookie on normal web pages.
 * The bundled custom scheme keeps its existing main-process boundary. */
function syncLocaleCookie(locale: string, nextLocale: string | undefined) {
  if (nextLocale === locale || !routing.locales.some(value => value === nextLocale)) return
  if (window.location.protocol !== 'https:' && window.location.protocol !== 'http:') return
  document.cookie = `NEXT_LOCALE=${nextLocale}; Max-Age=${routing.localeCookie.maxAge}; Path=${BASE_PATH || '/'}; SameSite=Lax`
}

export function useRouter() {
  const locale = useLocale()
  return useMemo(() => ({
    push: (href: Href, options?: { locale?: string; scroll?: boolean }) => {
      syncLocaleCookie(locale, options?.locale)
      navigate(href, false, { locale, ...options }, true)
    },
    replace: (href: Href, options?: { locale?: string; scroll?: boolean }) => {
      syncLocaleCookie(locale, options?.locale)
      navigate(href, true, { locale, ...options }, true)
    },
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh,
    prefetch: (_href: Href) => Promise.resolve(),
  }), [locale])
}

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function LocalizedLink({ href, locale: explicit, ...props }, ref) {
  const locale = useLocale()
  return <NextLink {...props} ref={ref} href={explicit === false ? href : localeHref(href, explicit ?? locale)} />
})
