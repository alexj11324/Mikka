/** The `mikka-workspace` value in a `document.cookie` string, or null when it has none (web's saved workspace pick). */
export function workspaceFromCookie(cookie: string): string | null {
  const pair = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('mikka-workspace='))
  if (!pair) return null
  try { return decodeURIComponent(pair.slice('mikka-workspace='.length)) || null } catch { return null }
}
