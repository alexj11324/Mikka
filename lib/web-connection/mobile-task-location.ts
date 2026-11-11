import { webSelectionVersion } from './selection'

// The official app renders this authenticated deep link through its existing
// router. The physical document URL and referrer contain only the opaque index.
let opened: { document: string; route: string; generation: number } | undefined

export function showMobileTaskLocation(document: string, query: URLSearchParams) {
  const route = new URL(document)
  route.hash = ''
  route.search = query.toString()
  opened = { document, route: route.href, generation: webSelectionVersion() }
}

export function mobileTaskLocation(href: string) {
  return opened?.document === href && opened.generation === webSelectionVersion() ? opened.route : href
}
