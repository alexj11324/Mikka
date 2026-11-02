import { AsyncLocalStorage } from 'node:async_hooks'

// The route template of the request being handled. Its own module, so code
// below the request log (the database sample, lib/db/egress-sample.ts) can
// read it without depending on the log itself.
const routeScope = new AsyncLocalStorage<string>()

export function withRequestRoute<T>(route: string, callback: () => T): T {
  return routeScope.run(route, callback)
}

export function currentRequestRoute(): string | undefined {
  return routeScope.getStore()
}
