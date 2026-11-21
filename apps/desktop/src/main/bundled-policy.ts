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
/** The Artifact page's task folder: the task's activity and the captures it links. Read-only. */
const FACTORY_ACTIVITY = /^\/api\/factory\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:activity|media\/[A-Za-z0-9_-]{1,128})$/i
const BILLING_MANAGEMENT = /^\/api\/(?:workspaces|organizations)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/billing$/i
const DRIVE_VOLUME_ID = 'vol_[0-9A-HJKMNP-TV-Z]{26}'
const DRIVE_VERSION_ID = 'vver_[0-9A-HJKMNP-TV-Z]{26}'
export const DRIVE_BLOB_UPLOAD = new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}/blobs$`)
const UUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89aAbB][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}'
const DRIVE_ROUTES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^\/api\/drive\/(?:scopes|shares)$/, ['GET']],
  [new RegExp(`^/api/drive/shares/${UUID}$`), ['GET']],
  [/^\/api\/drive\/volumes$/, ['GET', 'POST']],
  [new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}$`), ['GET']],
  [new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}/(?:files|versions)$`), ['GET']],
  [new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}/versions/${DRIVE_VERSION_ID}$`), ['GET']],
  [new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}/shares$`), ['GET', 'POST']],
  [new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}/shares/${UUID}$`), ['GET', 'PATCH', 'DELETE']],
  [DRIVE_BLOB_UPLOAD, ['POST']],
  [new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}/entries$`), ['PATCH']],
  [new RegExp(`^/api/drive/volumes/${DRIVE_VOLUME_ID}/(?:restore|archive|unarchive)$`), ['POST']],
]
const ORGANIZATION_DRIVE_ARCHIVE = new RegExp(`^/api/organizations/${UUID}/drive/${DRIVE_VOLUME_ID}/(?:archive|unarchive)$`)
const ORGANIZATION_DRIVE_RESTORE = new RegExp(`^/api/organizations/${UUID}/drive/${DRIVE_VOLUME_ID}/restore$`)
const ORGANIZATION_VOLUME_SHARES = new RegExp(`^/api/organizations/${UUID}/drive/${DRIVE_VOLUME_ID}/shares$`)
const ORGANIZATION_DRIVE_VERSIONS = new RegExp(`^/api/organizations/${UUID}/drive/${DRIVE_VOLUME_ID}/versions(?:/${DRIVE_VERSION_ID})?$`)
const ORGANIZATION_VERSION_FILE = new RegExp(`^/api/organizations/${UUID}/drive/${DRIVE_VOLUME_ID}/versions/${DRIVE_VERSION_ID}/files/[a-f0-9]{64}$`)
const ORGANIZATION_FILE_HISTORY = new RegExp(`^/api/organizations/${UUID}/drive/${DRIVE_VOLUME_ID}/file-versions$`)
const ORGANIZATION_FILE_SHARE = new RegExp(`^/api/organizations/${UUID}/drive-shares/${UUID}$`)
const ORGANIZATION_OVERVIEW = new RegExp(`^/api/organizations/${UUID}$`)
const ORGANIZATION_FILES = new RegExp(`^/api/organizations/${UUID}/(?:drive-shares|drive-scopes|drive-skills|drive)$`)
const ORGANIZATION_KEYS = new RegExp(`^/api/organizations/${UUID}/api-keys$`)
const ORGANIZATION_WORKSPACES = new RegExp(`^/api/organizations/${UUID}/workspaces$`)
const ORGANIZATION_POLICY = new RegExp(`^/api/organizations/${UUID}/policy$`)
const ORGANIZATION_APPROVALS = new RegExp(`^/api/organizations/${UUID}/approvals$`)
const ORGANIZATION_AUDIT = new RegExp(`^/api/organizations/${UUID}/audit-log$`)
const ORGANIZATION_DOMAINS = new RegExp(`^/api/organizations/${UUID}/allowed-domains$`)
const ORGANIZATION_DOMAIN = new RegExp(`^/api/organizations/${UUID}/allowed-domains/${UUID}$`)
const ORGANIZATION_JOIN = new RegExp(`^/api/organizations/${UUID}/join-by-domain$`)
const ORGANIZATION_KEY = new RegExp(`^/api/organizations/${UUID}/api-keys/${UUID}$`)
const WORKSPACE_GOVERNANCE = new RegExp(`^/api/workspaces/${UUID}/governance$`)
const ORGANIZATION_MEMBERS = new RegExp(`^/api/organizations/${UUID}/members$`)
const ORGANIZATION_INVITATIONS = new RegExp(`^/api/organizations/${UUID}/invitations$`)
const SERVICE_IDENTITY_DIRECTORY = `/api/workspaces/${UUID}/service-identities`
const SERVICE_IDENTITY_ROUTES: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`^${SERVICE_IDENTITY_DIRECTORY}$`), 'POST'],
  [new RegExp(`^${SERVICE_IDENTITY_DIRECTORY}/${UUID}$`), 'PATCH'],
  [new RegExp(`^${SERVICE_IDENTITY_DIRECTORY}/${UUID}/projects$`), 'PUT'],
  [new RegExp(`^${SERVICE_IDENTITY_DIRECTORY}/${UUID}/credential$`), 'POST'],
]
/** Route families are enumerated; there is deliberately no generic /api/* forwarding. */
const ROUTES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [new RegExp(`^/api/workspaces/${UUID}/devices/${UUID}/project-checkout(?:/clear)?$`), ['POST']],
  [new RegExp(`^/api/workspaces/${UUID}/projects/${UUID}/device-checkouts$`), ['GET']],
  [/^\/api\/agents\/eve\/v1\/session$/, ['POST']],
  [new RegExp(`^/api/agents/eve/v1/session/${ID}$`), ['GET', 'POST']],
  [new RegExp(`^/api/agents/eve/v1/session/${ID}/(?:cancel|compact|clear|end|reset)$`), ['POST']],
  [new RegExp(`^/api/agents/eve/v1/session/${ID}/(?:stream|stubs|descendants/stream)$`), ['GET']],
  [new RegExp(`^/api/agents/eve/v1/session/${ID}/subagents/${ID}/${ID}/stream$`), ['GET']],
  [/^\/api\/desktop\/config$/, ['GET']], [/^\/api\/desktop\/rpc$/, ['POST']],
  [/^\/api\/version$/, ['GET']], [/^\/api\/auth\/device$/, ['GET']],
  [/^\/api\/auth\/device\/(approve|deny)$/, ['POST']],
  [/^\/api\/(workspace|workspace\/switcher|search|issues\/search|skills|skills\/search|teams\/directory)$/, ['GET']],
  // Sharing an installed Skill into a workspace is the Skills panel's one write.
  [/^\/api\/skills\/share$/, ['POST']],
  [/^\/api\/settings\/(?:password|sessions|preferences|saved-logins|workspace-general|transfer-targets|deletion-impact|app-policy|share-policy|secrets|e2b-key|usage|billing|credit-billing|card-verification|audit|model-order|bots|workspace-bots|api-keys|environments)$/, ['GET']],
  [/^\/api\/agent-cli-policy$/, ['GET', 'POST']],
  // 收件箱 (Inbox) reads its page and writes its lifecycle commands here; both
  // are authorized per reader and workspace inside the handler.
  [/^\/api\/(bots|conversations|subscriptions|subscriptions\/usage|pending-actions|approved-writes|inbox|suggestions|computer\/events|agent\/sessions\/active)$/, ['GET', 'POST']],
  [/^\/api\/(coordinator\/(?:runtime|messages|attention))$/, ['GET', 'POST', 'DELETE']],
  [/^\/api\/(chat\/attachments|integrations\/mcp|integrations\/mcp\/shares|integrations\/mcp\/refresh|credentials|device-tokens)$/, ['GET', 'POST', 'PATCH', 'DELETE']],
  [/^\/api\/(agent\/images|agent\/sessions|devices|devices\/hosts)$/, ['GET']],
  [/^\/api\/devices\/ssh$/, ['POST']],
  [/^\/api\/github\/pull-request-status$/, ['POST']],
  [/^\/api\/(self-improvement|mobile\/reactions)$/, ['GET', 'POST']],
  [/^\/api\/factory\/(?:agent-profiles|tasks|tasks\/route|questions)$/, ['GET', 'POST']],
  [/^\/api\/integrations\/(github|github\/permissions|github\/tools|github\/repositories\/verification|github\/repositories\/pulls|github\/connect|github\/connect\/intent|github\/connect\/intent\/confirm|linear\/status|composio|composio\/credentials|composio\/catalog)$/, ['GET', 'POST', 'DELETE']],
  [/^\/api\/integrations\/composio$/, ['PATCH']],
  [/^\/api\/(subscriptions\/enrollments|subscriptions\/enrollments\/handoff|subscriptions\/enrollments\/bind)$/, ['GET', 'POST']],
  [/^\/api\/(billing\/stripe|account\/deletion)$/, ['GET', 'POST', 'DELETE']],
  [new RegExp(`^/api/(?:bots/${ID}(?:/(?:app-tools|definition|subagents(?:/${ID}(?:/(?:stop|viewer|credentials(?:/(?:challenge|login))?))?)?|computer(?:/(?:runtimes|subscription|takeover|runs|wake|handback|viewer))?))?|conversations/${ID}(?:/(?:decisions(?:/replay)?|members|stop|read|messages))?|suggestions/${ID}(?:/start)?|threads/${ID}/(?:machine|credentials(?:/(?:challenge|login))?))$`), ['GET', 'POST', 'PATCH', 'DELETE']],
  [new RegExp(`^/api/(?:workspaces/${ID}/(?:audit-log(?:/retention)?|skills|computer-policy|model-admission)|teams/${ID}/members|projects/${ID}/decisions(?:/from-message)?|conversation-links/${ID}/messages|integrations/composio/catalog/${ID}|devices/${ID}/commands|device-tokens/${ID}/revoke|computer/approvals/${ID})$`), ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']],
  [new RegExp(`^/api/(?:captures/${ID}|captures/shared/${ID}|artifacts/${ID}/versions/[0-9]+/(?:download|frame)|artifacts/shared/${ID}/frame|avatars/${ID}/${ID}|account/export/${ID})$`), ['GET']],
  // A chat attachment is read, and removed from the composer, by the same person.
  [new RegExp(`^/api/chat/attachments/${ID}$`), ['GET', 'DELETE']],
  [new RegExp(`^/api/tasks/${ID}/attachments$`), ['GET', 'POST', 'DELETE']],
  // New-task dictation (S2) transcribes one recording for the signed-in member.
  [/^\/api\/tasks\/dictation$/, ['POST']],
  // PR directory (S3): one PR's preview reads its detail and merges it; both re-check the reader's repository access.
  [/^\/api\/integrations\/github\/repositories\/pulls\/detail$/, ['GET']],
  [/^\/api\/integrations\/github\/repositories\/pulls\/merge$/, ['POST']],
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
  if (ORGANIZATION_VOLUME_SHARES.test(path)) return method === 'GET' || method === 'POST'
  if (ORGANIZATION_DRIVE_ARCHIVE.test(path) || ORGANIZATION_DRIVE_RESTORE.test(path)) return method === 'POST'
  if (ORGANIZATION_DRIVE_VERSIONS.test(path) || ORGANIZATION_VERSION_FILE.test(path) || ORGANIZATION_FILE_HISTORY.test(path)) return method === 'GET'
  if (ORGANIZATION_FILE_SHARE.test(path)) return method === 'PATCH' || method === 'DELETE'
  if (path.startsWith('/api/drive/')) return DRIVE_ROUTES.some(([pattern, methods]) => pattern.test(path) && methods.includes(method))
  if (path === '/api/settings/issue-prefix' || path === '/api/settings/environments' || path === '/api/settings/thread-titles') return method === 'GET'
  // This human approval/read surface has exactly its declared methods. Do not
  // inherit the wider CRUD family or the generic asset HEAD allowance.
  if (FACTORY_FLOW.test(path)) return method === 'GET' || method === 'POST'
  if (FACTORY_ACTIVITY.test(path)) return method === 'GET'
  if (BILLING_MANAGEMENT.test(path)) return method === 'GET' || method === 'POST'
  if (path.startsWith('/api/workspaces/') && path.includes('/service-identities')) {
    return SERVICE_IDENTITY_ROUTES.some(([route, mutation]) => route.test(path) && (method === 'GET' || method === mutation))
  }
  if (WORKSPACE_GOVERNANCE.test(path) || ORGANIZATION_KEYS.test(path) || ORGANIZATION_FILES.test(path)) return method === 'GET'
  if (path === '/api/organizations') return method === 'GET' || method === 'POST'
  if (path === '/api/organizations/deleted') return method === 'GET'
  if (ORGANIZATION_OVERVIEW.test(path)) return method === 'GET' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
  if (ORGANIZATION_WORKSPACES.test(path)) return method === 'POST' || method === 'DELETE'
  if (path === '/api/me/joinable-organizations' || path === '/api/me/invitations') return method === 'GET'
  if (ORGANIZATION_POLICY.test(path)) return method === 'GET' || method === 'PATCH'
  if (ORGANIZATION_APPROVALS.test(path)) return method === 'POST' || method === 'PATCH'
  if (ORGANIZATION_AUDIT.test(path)) return method === 'GET' || method === 'POST'
  if (ORGANIZATION_DOMAINS.test(path)) return method === 'GET' || method === 'POST'
  if (ORGANIZATION_DOMAIN.test(path)) return method === 'DELETE'
  if (ORGANIZATION_JOIN.test(path)) return method === 'POST'
  if (ORGANIZATION_KEY.test(path)) return method === 'PATCH'
  if (ORGANIZATION_MEMBERS.test(path)) return method === 'GET' || method === 'POST' || method === 'PATCH' || method === 'DELETE'
  if (ORGANIZATION_INVITATIONS.test(path)) return method === 'GET' || method === 'POST' || method === 'DELETE'
  if (path === '/api/organization-invitations/accept') return method === 'POST'
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
