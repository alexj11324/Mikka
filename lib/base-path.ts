// The app is served under a path prefix (app.aspectlylabs.com/mikka); see
// next.config.mjs. Next adds it to <Link>, router and redirect() targets, but
// not to fetch(), plain <a href>, window.location or absolute URLs, so those
// go through withBasePath.
export const BASE_PATH = process.env.MIKKA_BASE_PATH ?? ''

export function withBasePath(path: string) {
  // The app root is /mikka, not /mikka/ (which Next would redirect).
  if (BASE_PATH && (path === '/' || path.startsWith('/?') || path.startsWith('/#'))) return `${BASE_PATH}${path.slice(1)}`
  return `${BASE_PATH}${path}`
}
