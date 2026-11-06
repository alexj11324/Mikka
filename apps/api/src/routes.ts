export type RouteModule = Record<string, unknown>
export type ApiRoute = {
  path: string
  template: string
  source: string
  methods: string[]
  maxDuration?: number
  sourceHash?: string
  load: () => Promise<RouteModule>
}
export type RouteMatch = { route: ApiRoute; params: Record<string, string | string[]> }
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function routeMatcher(route: ApiRoute): (pathname: string) => RouteMatch | undefined {
  const names: Array<{ name: string; many: boolean }> = []
  const pattern = route.path.split('/').map(segment => {
    const optional = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(segment)
    const rest = /^\[\.\.\.([^\]]+)\]$/.exec(segment)
    const single = /^\[([^\]]+)\]$/.exec(segment)
    if (optional || rest || single) {
      names.push({ name: (optional ?? rest ?? single)![1], many: Boolean(optional || rest) })
      return optional ? '(.*)' : rest ? '(.+)' : '([^/]+)'
    }
    return escape(segment)
  }).join('/')
  const expression = new RegExp(`^${pattern.replace('/(.*)', '(?:/(.*))?')}$`)
  return pathname => {
    const match = expression.exec(pathname)
    if (!match) return undefined
    const params: RouteMatch['params'] = {}
    for (const [index, entry] of names.entries()) {
      const value = match[index + 1]
      if (value === undefined || (entry.many && !value)) continue
      params[entry.name] = entry.many ? value.split('/').map(decodeURIComponent) : decodeURIComponent(value)
    }
    return { route, params }
  }
}
export function routerPath(path: string): string {
  return path.replace(/\[\[?\.\.\.[^\]]+\]\]?/g, '*').replace(/\[([^\]]+)\]/g, ':$1')
}
export function allowedMethods(route: ApiRoute): string[] {
  const methods = new Set(route.methods)
  if (methods.has('GET')) methods.add('HEAD')
  methods.add('OPTIONS')
  return [...methods].sort()
}
