const appPaths = new Set(['/', '/settings', '/settings/teams', '/settings/members'])

export function isLocalSettingsNavigation(current: URL, destination: URL, _workspaceId?: string) {
  // Every supported path renders WorkspaceApp; data requests still enforce session and workspace access.
  return current.origin === destination.origin && appPaths.has(current.pathname) && appPaths.has(destination.pathname)
}

export function pushSettingsHistory(href: string, workspaceId?: string) {
  const current = new URL(window.location.href)
  const destination = new URL(href, current)
  if (!isLocalSettingsNavigation(current, destination, workspaceId)) return false
  if (current.href !== destination.href) {
    window.history.pushState(null, '', `${destination.pathname}${destination.search}${destination.hash}`)
    document.querySelector('[data-slot="sidebar-inset"]')?.scrollTo({ top: 0 })
  }
  return true
}
