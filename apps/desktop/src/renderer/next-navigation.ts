import { useMemo } from 'react'
import { navigate, refresh, useLocation, withoutBase, withoutLocale } from './location'

const router = {
  push: (href: string, options?: { scroll?: boolean }) => navigate(href, false, options),
  replace: (href: string, options?: { scroll?: boolean }) => navigate(href, true, options),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh,
  // Assets are already in the app. Route prefetch must not perform server reads.
  prefetch: (_href: string) => Promise.resolve(),
}

export const useRouter = () => router
export const usePathname = () => withoutBase(useLocation().pathname)
export function useSearchParams() {
  const search = useLocation().search
  return useMemo(() => new URLSearchParams(search), [search])
}
export function useParams() {
  const pathname = withoutLocale(useLocation().pathname)
  return useMemo(() => {
    const match = /^\/(?:a|invite)\/([^/]+)$/.exec(pathname)
    return match ? { token: decodeURIComponent(match[1]) } : {}
  }, [pathname])
}

export function redirect(href: string) { navigate(href, true) }
export function notFound(): never { throw new Error('desktop_route_not_found') }
