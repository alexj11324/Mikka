const BASE_PATH = process.env.MIKKA_BASE_PATH ?? ''
const appPaths = new Set(['/', '/settings', '/settings/teams', '/settings/members'])
const locales = new Set(['en', 'zh-CN'])

type AppRoute = { pathname: string; locale?: string }

function appRoute(pathname: string, basePath: string): AppRoute | null {
  let routePath = pathname
  if (basePath) {
    if (routePath === basePath) routePath = '/'
    else if (routePath.startsWith(`${basePath}/`)) routePath = routePath.slice(basePath.length)
    else return null
  }

  const localePrefix = /^\/([^/]+)(?=\/|$)/.exec(routePath)?.[1]
  const locale = localePrefix && locales.has(localePrefix) ? localePrefix : undefined
  if (locale) routePath = routePath.slice(locale.length + 1) || '/'
  return { pathname: routePath, locale }
}

function appPath(route: AppRoute, locale: string | undefined, basePath: string) {
  const localePrefix = locale ? `/${locale}` : ''
  const routePath = route.pathname === '/' ? '' : route.pathname
  return `${basePath}${localePrefix}${routePath}` || '/'
}

export function isLocalSettingsNavigation(current: URL, destination: URL, _workspaceId?: string, basePath = BASE_PATH) {
  // Every supported path renders WorkspaceApp; data requests still enforce session and workspace access.
  const currentRoute = appRoute(current.pathname, basePath)
  const destinationRoute = appRoute(destination.pathname, basePath)
  return current.origin === destination.origin && !!currentRoute && !!destinationRoute &&
    appPaths.has(currentRoute.pathname) && appPaths.has(destinationRoute.pathname)
}

export function pushSettingsHistory(href: string, workspaceId?: string, basePath = BASE_PATH) {
  const current = new URL(window.location.href)
  const requested = new URL(href, current)
  if (requested.origin !== current.origin) return false

  const currentRoute = appRoute(current.pathname, basePath)
  const destinationRoute = appRoute(requested.pathname, basePath) ?? appRoute(requested.pathname, '')
  if (!currentRoute || !destinationRoute || !appPaths.has(currentRoute.pathname) || !appPaths.has(destinationRoute.pathname)) return false

  const locale = destinationRoute.locale ?? currentRoute.locale
  requested.pathname = appPath(destinationRoute, locale, basePath)
  if (!isLocalSettingsNavigation(current, requested, workspaceId, basePath)) return false

  if (current.href !== requested.href) {
    window.history.pushState(null, '', `${requested.pathname}${requested.search}${requested.hash}`)
    document.querySelector('[data-slot="sidebar-inset"]')?.scrollTo({ top: 0 })
  }
  return true
}
