import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from 'react'
import { withBasePath } from '@/lib/base-path'
import { hrefString, isClientRoute, navigate, type Href } from './location'

export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: Href
  replace?: boolean
  scroll?: boolean
  prefetch?: boolean | null
  locale?: string | false
  onNavigate?: (event: { preventDefault(): void }) => void
}

/** The existing Link component's client navigation behavior, with no RSC fetch. */
const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ href, replace, scroll, prefetch: _prefetch, locale: _locale, onNavigate, onClick, ...props }, ref) {
  const value = withBasePath(hrefString(href))
  function click(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target === '_blank' || props.download !== undefined) return
    const url = new URL(value, window.location.href)
    if (!isClientRoute(url)) return
    let prevented = false
    onNavigate?.({ preventDefault() { prevented = true } })
    event.preventDefault()
    if (!prevented) navigate(value, replace, { scroll })
  }
  return <a {...props} href={value} ref={ref} onClick={click} />
})

export default Link
