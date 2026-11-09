import { isSettingsSectionParam } from './settings-sections'

export const COMPOSIO_AUTH_CALLBACK_PATH = '/api/integrations/composio/callback'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const internalOrigin = 'https://mikka.invalid'
/**
 * An app with a page on 插件 and 设置 › 连接 (`&app=`): any store app, so a
 * toolkit slug in the catalog's shape (lib/composio-accounts.ts TOOLKIT_SLUG).
 * Only the shape is allowed; the value is never a URL or a path.
 */
const isPluginApp = (value: string) => /^[a-z][a-z0-9_]{0,63}$/.test(value)

function hasOnlyQueryKeys(url: URL, allowed: readonly string[]) {
  const entries = [...url.searchParams.entries()]
  return entries.every(([key]) => allowed.includes(key)) && new Set(entries.map(([key]) => key)).size === entries.length
}

function optionalUuid(url: URL, key: string) {
  const value = url.searchParams.get(key)
  return value === null || uuidPattern.test(value)
}

export function safeAuthReturn(value?: string) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'

  const url = new URL(value, internalOrigin)
  if (url.origin !== internalOrigin || url.hash) return '/'
  if (/^\/invite\/[a-f0-9]{64}$/.test(url.pathname) && !url.search) return url.pathname
  if (url.pathname === '/devices' && !url.search) return '/settings?section=devices'
  if (url.pathname === '/device') {
    const code = url.searchParams.get('user_code')
    return hasOnlyQueryKeys(url, ['user_code']) && (code === null || /^[A-Z0-9-]{4,32}$/.test(code))
      ? `${url.pathname}${url.search}` : '/'
  }
  if (/^\/w\/[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])$/.test(url.pathname) && !url.search) return url.pathname
  if (url.pathname === '/workspaces/new' && !url.search) return '/workspaces/new'
  if (url.pathname === COMPOSIO_AUTH_CALLBACK_PATH && !url.search) return COMPOSIO_AUTH_CALLBACK_PATH

  if (url.pathname === '/') {
    // The plugins page and one app's page there (?section=plugins&app=gmail).
    const app = url.searchParams.get('app')
    if (url.searchParams.get('section') === 'plugins' && hasOnlyQueryKeys(url, ['section', 'app'])) {
      return app === null ? '/?section=plugins' : isPluginApp(app) ? `/?section=plugins&app=${app}` : '/'
    }
    // A desktop Link GitHub whose browser had to sign in first: back to GitHub's page with the one-time link token.
    const intent = url.searchParams.get('intent')
    if (url.searchParams.get('section') === 'plugins' && app === 'github' && hasOnlyQueryKeys(url, ['section', 'app', 'intent']) && intent && /^ghi_[A-Za-z0-9_-]{43}$/.test(intent)) {
      return `/?section=plugins&app=github&intent=${intent}`
    }
    // A cold desktop deep link can open any place the existing workspace
    // address owns, including a thread beside a bot and an Artifact window.
    // Values remain local enums or UUIDs; none can become a redirect URL.
    const idKeys = ['bot', 'group', 'session', 'team', 'project', 'issue', 'thread', 'artifact']
    const section = url.searchParams.get('section')
    const threads = url.searchParams.get('threads')
    const sections = ['coordinator', 'agent', 'plugins', 'suggestions', 'artifacts', 'memory', 'all-issues', 'projects', 'team-home', 'team-issues', 'team-projects']
    return hasOnlyQueryKeys(url, ['section', ...idKeys, 'threads']) &&
      idKeys.every(key => optionalUuid(url, key)) &&
      (section === null || sections.includes(section)) &&
      (threads === null || threads === 'all' || uuidPattern.test(threads))
      ? `${url.pathname}${url.search}` : '/'
  }

  if (url.pathname === '/settings') {
    const section = url.searchParams.get('section')
    // 设置 › 连接 also opens one app's page (&app=github), like the plugins page.
    const app = url.searchParams.get('app')
    const appOk = app === null || ((section === 'connections' || section === 'integrations') && isPluginApp(app))
    return hasOnlyQueryKeys(url, ['section', 'workspace', 'app']) &&
      (section === null || isSettingsSectionParam(section)) && appOk &&
      optionalUuid(url, 'workspace') ? `${url.pathname}${url.search}` : '/'
  }

  if (url.pathname === '/settings/teams') {
    const create = url.searchParams.get('create')
    const view = url.searchParams.get('view')
    return hasOnlyQueryKeys(url, ['workspace', 'team', 'create', 'view']) &&
      optionalUuid(url, 'workspace') && optionalUuid(url, 'team') &&
      (create === null || create === '1') &&
      (view === null || ['general', 'members'].includes(view)) ? `${url.pathname}${url.search}` : '/'
  }

  if (url.pathname === '/settings/members') {
    const invite = url.searchParams.get('invite')
    return hasOnlyQueryKeys(url, ['workspace', 'invite']) && optionalUuid(url, 'workspace') &&
      (invite === null || invite === '1') ? `${url.pathname}${url.search}` : '/'
  }

  return '/'
}

/**
 * When an agent's OAuth sign-in (lib/auth.ts) sends the person to the sign-in
 * page, its query holds the signed authorization request. After signing in,
 * the person goes back to the authorize endpoint with the same request, which
 * now finds a session and moves on to consent. Null for an ordinary sign-in.
 * The path has no base path; the authorize endpoint checks every parameter.
 */
export function oauthResumePath(query: Record<string, string | string[] | undefined>): string | null {
  if (typeof query.sig !== 'string' || typeof query.client_id !== 'string') return null
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || ['sig', 'exp', 'prompt', 'oauth', 'continue', 'next', 'error'].includes(key) || key.startsWith('ba_')) continue
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item)
  }
  return `/api/auth/oauth2/authorize?${params}`
}
