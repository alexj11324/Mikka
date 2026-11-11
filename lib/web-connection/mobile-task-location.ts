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

// Browser history can outlive both a connection and its account. Reopening a
// history entry must not silently select the previous server.
export function canResumeMobileTask(server: string, cloud: boolean, userId: string, selection: {
  account: { server: string; user: { id: string } } | null
  expiredServer: string | null
}) {
  if (selection.expiredServer) return false
  if (cloud) return selection.account === null
  return selection.account?.server === server && selection.account.user.id === userId
}
