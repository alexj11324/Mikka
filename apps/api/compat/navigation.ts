export class NavigationResponse extends Error {
  constructor(readonly status: number, readonly location?: string) { super('API_NAVIGATION_RESPONSE') }
}
export const RedirectType = { push: 'push', replace: 'replace' } as const
export function redirect(url: string, _type?: 'push' | 'replace'): never { throw new NavigationResponse(307, url) }
export function permanentRedirect(url: string, _type?: 'push' | 'replace'): never { throw new NavigationResponse(308, url) }
export function notFound(): never { throw new NavigationResponse(404) }
