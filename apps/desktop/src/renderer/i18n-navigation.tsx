import { forwardRef, useMemo } from 'react'
import { useLocale } from 'next-intl'
import NextLink, { type LinkProps } from './next-link'
import { localeHref, navigate, refresh, useLocation, withoutLocale, type Href } from './location'

export const usePathname = () => withoutLocale(useLocation().pathname)
export const getPathname = ({ href, locale }: { href: Href; locale: string }) => localeHref(href, locale)
export const redirect = ({ href, locale }: { href: Href; locale: string }) => navigate(href, true, { locale }, true)

export function useRouter() {
  const locale = useLocale()
  return useMemo(() => ({
    push: (href: Href, options?: { locale?: string; scroll?: boolean }) => navigate(href, false, { locale, ...options }, true),
    replace: (href: Href, options?: { locale?: string; scroll?: boolean }) => navigate(href, true, { locale, ...options }, true),
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
