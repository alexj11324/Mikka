import { resolve, sep } from 'node:path'

export const RENDERER_ORIGIN = 'mikka://app'
export const RENDERER_URL = `${RENDERER_ORIGIN}/mikka`

/** No remote scripts, eval, workers or remote websocket connections. */
export const RENDERER_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:", "font-src 'self' data:", "connect-src 'self'",
  "media-src 'self' blob:", "frame-src 'self' https:", "object-src 'none'", "base-uri 'none'",
  "form-action 'none'", "frame-ancestors 'none'", "worker-src 'none'",
].join('; ')

const ID = '[A-Za-z0-9_-]{1,128}'
const FACTORY_FLOW = /^\/api\/factory\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/flow$/i
const BILLING_MANAGEMENT = /^\/api\/(?:workspaces|organizations)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/billing$/i
const DRIVE_VOLUME_ID = 'vol_[0-9A-HJKMNP-TV-Z]{26}'
const DRIVE_VERSION_ID = 'vver_[0-9A-HJKMNP-TV-Z]{26}'
const DRIVE_ROUTES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^\/api\/drive\/volumes$/, ['GET', 'POST']],
  [new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}$`), ['GET']],
  [new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}/(?:files|versions)$`), ['GET']],
  [new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}/versions/${DRIVE_VERSION_ID}$`), ['GET']],
  [new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}/blobs$`), ['POST']],
  [new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}/entries$`), ['PATCH']],
  [new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}/(?:restore|archive|unarchive)$`), ['POST']],
]
const UUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89aAbB][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}'
const ORGANIZATION_OVERVIEW_OR_KEYS = new RegExp(`^/api/organizations/${UUID}(?:/api-keys)?$`)
const ORGANIZATION_KEY = new RegExp(`^/api/organizations/${UUID}/api-keys/${UUID}$`)
const WORKSPACE_GOVERNANCE = new RegExp(`^/api/workspaces/${UUID}/governance$`)
const SERVICE_IDENTITY_DIRECTORY = `/api/workspaces/${UUID}/service-identities`
const SERVICE_IDENTITY_ROUTES: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`^${SERVICE_IDENTITY_DIRECTORY}$`), 'POST'],
  [new RegExp(`^${SERVICE_IDENTITY_DIRECTORY}/${UUID}$`), 'PATCH'],
  [new RegExp(`^${SERVICE_IDENTITY_DIRECTORY}/${UUID}/projects$`), 'PUT'],
  [new RegExp(`^${SERVICE_IDENTITY_DIRECTORY}/${UUID}/credential$`), 'POST'],
]
/** Route families are enumerated; there is deliberately no generic /api/* forwarding. */
const ROUTES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^\/api\/agents\/eve\/v1\/session$/, ['POST']],
  [new RegExp(`^/api/agents/eve/v1/session/${ID}$`), ['GET', 'POST']],
  [new RegExp(`^/api/agents/eve/v1/session/${ID}/(?:cancel|compact|clear|end|reset)$`), ['POST']],
  [new RegExp(`^/api/agents/eve/v1/session/${ID}/(?:stream|stubs|descendants/stream)$`), ['GET']],
  [new RegExp(`^/api/agents/eve/v1/session/${ID}/subagents/${ID}/${ID}/stream$`), ['GET']],
  [/^\/api\/desktop\/config$/, ['GET']], [/^\/api\/desktop\/rpc$/, ['POST']],
  [/^\/api\/version$/, ['GET']], [/^\/api\/auth\/device$/, ['GET']],
  [/^\/api\/auth\/device\/(approve|deny)$/, ['POST']],
  [/^\/api\/(workspace|workspace\/switcher|search|issues\/search|skills|skills\/search|teams\/directory)$/, ['GET']],
  [/^\/api\/settings\/(?:password|sessions|preferences|saved-logins|workspace-general|transfer-targets|deletion-impact|app-policy|share-policy|secrets|e2b-key|usage|billing|credit-billing|card-verification|audit|model-order|bots|workspace-bots|api-keys|environments)$/, ['GET']],
  [/^\/api\/agent-cli-policy$/, ['GET', 'POST']],
  [/^\/api\/(bots|conversations|subscriptions|subscriptions\/usage|pending-actions|approved-writes|suggestions|computer\/events|agent\/sessions\/active)$/, ['GET', 'POST']],
  [/^\/api\/(coordinator\/(?:runtime|messages|attention))$/, ['GET', 'POST', 'DELETE']],
  [/^\/api\/(chat\/attachments|integrations\/mcp|integrations\/mcp\/shares|credentials|device-tokens)$/, ['GET', 'POST', 'PATCH', 'DELETE']],
  [/^\/api\/(agent\/images|agent\/sessions|devices\/hosts)$/, ['GET']],
  [/^\/api\/devices\/ssh$/, ['POST']],
  [/^\/api\/github\/pull-request-status$/, ['POST']],
  [/^\/api\/(self-improvement|mobile\/reactions)$/, ['GET', 'POST']],
  [/^\/api\/factory\/(?:agent-profiles|tasks|tasks\/route|questions)$/, ['GET', 'POST']],
  [/^\/api\/integrations\/(github|github\/permissions|github\/repositories\/verification|github\/connect|github\/connect\/intent|github\/connect\/intent\/confirm|linear\/status|composio|composio\/credentials|composio\/catalog)$/, ['GET', 'POST', 'DELETE']],
  [/^\/api\/integrations\/composio$/, ['PATCH']],
  [/^\/api\/(subscriptions\/enrollments|subscriptions\/enrollments\/handoff|subscriptions\/enrollments\/bind)$/, ['GET', 'POST']],
  [/^\/api\/(billing\/stripe|account\/deletion)$/, ['GET', 'POST', 'DELETE']],
  [new RegExp(`^/api/(?:bots/${ID}(?:/(?:definition|subagents(?:/${ID}(?:/(?:stop|viewer|credentials(?:/(?:challenge|login))?))?)?|computer(?:/(?:runtimes|subscription|takeover|runs|wake|handback|viewer))?))?|conversations/${ID}(?:/(?:decisions(?:/replay)?|members|stop|read|messages))?|suggestions/${ID}(?:/start)?|threads/${ID}/(?:machine|credentials(?:/(?:challenge|login))?))$`), ['GET', 'POST', 'PATCH', 'DELETE']],
  [new RegExp(`^/api/(?:workspaces/${ID}/(?:audit-log(?:/retention)?|skills|computer-policy|model-admission)|teams/${ID}/members|projects/${ID}/decisions(?:/from-message)?|conversation-links/${ID}/messages|integrations/composio/catalog/${ID}|devices/${ID}/commands|device-tokens/${ID}/revoke|computer/approvals/${ID})$`), ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']],
  [new RegExp(`^/api/(?:chat/attachments/${ID}|captures/${ID}|captures/shared/${ID}|artifacts/${ID}/versions/[0-9]+/(?:download|frame)|artifacts/shared/${ID}/frame|avatars/${ID}/${ID}|account/export/${ID})$`), ['GET']],
  [new RegExp(`^/api/artifacts/shared/${ID}$`), ['GET']],
  [new RegExp(`^/api/(?:mobile/(?:bots|artifacts)/${ID}|runs/${ID}/evidence)$`), ['GET']],
  [new RegExp(`^/api/factory/(?:agent-profiles/${ID}|tasks/${ID}(?:/(?:approval|dispatch(?:/cloud)?|evidence/${ID}))?|questions/${ID}(?:/recover)?|monitor-incidents/${ID}/links)$`), ['GET', 'POST', 'PATCH', 'DELETE']],
]

/** Check before URL construction: WHATWG URL normalization must not erase traversal evidence. */
export function normalizedRendererPath(value: string): string | null {
  // oxlint-disable-next-line no-control-regex -- Reject NUL, controls and URL whitespace before parsing.
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 8192 || /[\\\x00-\x20\x7f]/.test(value)) return null
  const raw = value.split(/[?#]/, 1)[0]!
  if (/%(?:2e|2f|5c|00|25)/i.test(raw) || raw.split('/').some(part => part === '.' || part === '..')) return null
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { return null }
  if (decoded.includes('\\') || decoded.split('/').some(part => part === '.' || part === '..')) return null
  return decoded === '/mikka' ? '/' : decoded.startsWith('/mikka/') ? decoded.slice(6) : null
}

export function allowedApiPath(path: string, method: string): boolean {
  if (path.startsWith('/api/drive/')) return DRIVE_ROUTES.some(([pattern, methods]) => pattern.test(path) && methods.includes(method))
  if (path === '/api/settings/issue-prefix' || path === '/api/settings/environments') return method === 'GET'
  // This human approval/read surface has exactly its declared methods. Do not
  // inherit the wider CRUD family or the generic asset HEAD allowance.
  if (FACTORY_FLOW.test(path)) return method === 'GET' || method === 'POST'
  if (BILLING_MANAGEMENT.test(path)) return method === 'GET' || method === 'POST'
  if (path.startsWith('/api/workspaces/') && path.includes('/service-identities')) {
    return SERVICE_IDENTITY_ROUTES.some(([route, mutation]) => route.test(path) && (method === 'GET' || method === mutation))
  }
  if (WORKSPACE_GOVERNANCE.test(path) || path === '/api/organizations' || ORGANIZATION_OVERVIEW_OR_KEYS.test(path)) return method === 'GET'
  if (ORGANIZATION_KEY.test(path)) return method === 'PATCH'
  // Viewer grants are capabilities and must be obtained through owner-bound IPC.
  if (/^\/api\/bots\/[^/]+\/(?:computer\/(?:viewer|takeover)|subagents\/[^/]+\/viewer)$/.test(path)) return false
  return ROUTES.some(([pattern, methods]) => pattern.test(path) && methods.includes(method === 'HEAD' ? 'GET' : method))
}

export function rendererAssetPath(root: string, urlPath: string): string | null {
  const path = normalizedRendererPath(urlPath)
  if (!path || path.startsWith('/api/')) return null
  const absolute = resolve(root, `.${path}`)
  return absolute === resolve(root) || absolute.startsWith(`${resolve(root)}${sep}`) ? absolute : null
}

export function safeAppNext(value: unknown): string {
  // oxlint-disable-next-line no-control-regex -- Return targets cannot contain controls or whitespace.
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\#\x00-\x20]/.test(value) || /%(?:2f|5c|00)/i.test(value)) return '/'
  return value
}

export function remoteBase(value: string): URL {
  const url = new URL(value)
  if (url.username || url.password || url.hash || url.search || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid desktop server / 桌面服务地址无效')
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Desktop server requires HTTPS / 桌面服务必须使用 HTTPS')
  return url
}
