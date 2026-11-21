// The app is served under a path prefix (app.aspectlylabs.com/mikka), fixed in
// lib/base-path-config.mjs and inlined as MIKKA_BASE_PATH by
// apps/frontend/vite.config.mjs. The router adds it to link and redirect
// targets, but not to fetch(), plain <a href>, window.location or absolute
// URLs, so those go through withBasePath.
export const BASE_PATH = process.env.MIKKA_BASE_PATH ?? ''

export function withBasePath(path: string, basePath = BASE_PATH) {
  if (!basePath || !path.startsWith('/') || path.startsWith('//')) return path
  if (
    path === basePath ||
    path.startsWith(`${basePath}/`) ||
    path.startsWith(`${basePath}?`) ||
    path.startsWith(`${basePath}#`)
  )
    return path
  // The app root is /mikka, not /mikka/ (which Next would redirect).
  if (path === '/' || path.startsWith('/?') || path.startsWith('/#')) return `${basePath}${path.slice(1)}`
  return `${basePath}${path}`
}
