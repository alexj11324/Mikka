/**
 * Redirect and not-found answers from inside a handler.
 *
 * A route handler cannot return a location directly from nested code, so these
 * throw; the dispatcher in `apps/api/src/application.ts` turns the marker into
 * the matching HTTP response.
 */
export class NavigationResponse extends Error {
  constructor(readonly status: number, readonly location?: string) { super('API_NAVIGATION_RESPONSE') }
}
export const RedirectType = { push: 'push', replace: 'replace' } as const
export function redirect(url: string, _type?: 'push' | 'replace'): never { throw new NavigationResponse(307, url) }
export function permanentRedirect(url: string, _type?: 'push' | 'replace'): never { throw new NavigationResponse(308, url) }
export function notFound(): never { throw new NavigationResponse(404) }
