const origin = 'https://mikka.invalid'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const toolkit = /^[a-z][a-z0-9_]{0,63}$/

/** The account/integration pages that start OAuth in the system browser.
 * No provider URL, callback, auth endpoint or caller-supplied redirect can be
 * attached to an authenticated handoff. Paths do not include the base path. */
export function desktopWebTarget(value: string | null): string | null {
  // oxlint-disable-next-line no-control-regex -- URL normalization must not hide path separators or control bytes.
  if (!value || value.length > 1024 || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value)) return null
  let url: URL
  try { url = new URL(value, origin) } catch { return null }
  if (url.origin !== origin || url.hash || /%(?:2e|2f|5c|00|25)/i.test(value.split('?')[0]!)) return null
  const locale = /^\/en(?:\/|$)/.test(url.pathname) ? '/en' : ''
  const path = locale ? url.pathname.slice(locale.length) || '/' : url.pathname
  const entries = [...url.searchParams.entries()]
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return null
  const only = (allowed: string[]) => entries.every(([key]) => allowed.includes(key))
  const section = url.searchParams.get('section')
  const settings = url.searchParams.get('settings')
  const app = url.searchParams.get('app')
  const appAllowed = app === null || toolkit.test(app)
  const workspace = url.searchParams.get('workspace')
  if (workspace !== null && !uuid.test(workspace)) return null
  let accepted = false
  if (path === '/') {
    accepted = (section === 'plugins' && appAllowed && only(['section', 'app'])) ||
      ((settings === 'account' || settings === 'integrations') && (app === null || settings === 'integrations') && appAllowed && only(['settings', 'app']))
  } else if (path === '/settings') {
    accepted = (section === 'account' || section === 'integrations' || section === 'connections') &&
      (app === null || section !== 'account') && appAllowed && only(['section', 'app', 'workspace'])
  }
  if (!accepted) return null
  if (workspace) url.searchParams.set('workspace', workspace.toLowerCase())
  return `${locale}${path === '/' && locale ? '' : path}${url.search}`
}
