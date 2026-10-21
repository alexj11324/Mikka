export function isLocalSettingsNavigation(current: URL, destination: URL, workspaceId?: string) {
  if (current.origin !== destination.origin || current.pathname !== destination.pathname) return false
  if (current.pathname !== '/settings' && current.pathname !== '/settings/teams') return false
  const currentWorkspace = current.searchParams.get('workspace') ?? workspaceId
  const destinationWorkspace = destination.searchParams.get('workspace') ?? workspaceId
  return currentWorkspace === destinationWorkspace
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
