/** Authentication and app handoffs remain available on a server whose full
 * community UI is disabled. This is a presentation boundary, not permission
 * to bypass the existing API, session or workspace authorization. */
export type ServerPageKind = 'authentication' | 'github'

export function serverPageKind(url: URL): ServerPageKind | null {
  const path = url.pathname.replace(/^\/mikka(?=\/|$)/, '').replace(/^\/(?:en|zh-CN)(?=\/|$)/, '') || '/'
  if (['/sign-in', '/sign-up', '/forgot-password', '/reset-password', '/verify-email', '/device', '/oauth/consent', '/workspaces/new'].includes(path)
    || /^\/invite\/[a-f0-9]{64}$/.test(path) || /^\/a\/[^/]+$/.test(path)
    || /^\/w\/[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(path)) return 'authentication'
  if (path !== '/' || url.searchParams.get('section') !== 'plugins' || url.searchParams.get('app') !== 'github') return null
  const keys = [...url.searchParams.keys()]
  if (new Set(keys).size !== keys.length || keys.some(key => !['section', 'app', 'intent', 'github', 'reason'].includes(key))) return null
  const intent = url.searchParams.get('intent'), result = url.searchParams.get('github'), reason = url.searchParams.get('reason')
  if (intent !== null && !/^ghi_[A-Za-z0-9_-]{43}$/.test(intent)) return null
  if (result !== null && result !== 'link-failed') return null
  if (reason !== null && !['cancelled', 'account', 'expired', 'browser-account'].includes(reason)) return null
  return 'github'
}

/** Only a document served by the local backend sets this marker. A selected
 * remote server's discovery/bootstrap can never put the official app into it;
 * desktop/iOS documents do not carry the marker either. */
export function serverDocumentKind(): ServerPageKind | 'status' | null {
  const kind = typeof document === 'undefined' ? undefined : document.documentElement?.dataset.mikkaServerPage
  return kind === 'authentication' || kind === 'github' || kind === 'status' ? kind : null
}
