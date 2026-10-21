// Login contract shared by apps/server and apps/desktop (ADR 0007). The
// desktop flow itself (system browser, PKCE, one-time code, deep link,
// encrypted session storage) is Better Auth's Electron plugin
// (@better-auth/electron); this file only holds what Orvilo adds around it.
import { z } from "zod"

export const AUTH_PROVIDERS = ["github", "google"] as const
export const authProvider = z.enum(AUTH_PROVIDERS)
export type AuthProvider = z.infer<typeof authProvider>

/** Deep-link scheme per desktop flavor; the server allow-lists them. */
export const DESKTOP_SCHEMES = ["orvilo", "orvilo-dev"] as const
export const desktopScheme = z.enum(DESKTOP_SCHEMES)
export type DesktopScheme = z.infer<typeof desktopScheme>

/**
 * Deep-link scheme of the phone app (`apps/mobile/app.json`'s `scheme`). The
 * phone has one scheme and no dev flavor: a development build deep-links back
 * through `orvilo://` too, and Expo Go — development only — owns `exp://`
 * instead (ADR 0032).
 */
export const MOBILE_SCHEME = "orvilo"
/** Expo Go's scheme; the server trusts it in development only. */
export const EXPO_GO_SCHEME = "exp"

/**
 * Origins the server trusts for the phone. `orvilo://` carries no authority
 * and no path, so it matches whatever host and path the app deep-links back
 * to (`orvilo://<metro host>/`, or `orvilo://` in a release build).
 */
export function mobileTrustedOrigins(options: { isDev: boolean }): string[] {
  return [
    `${MOBILE_SCHEME}://`,
    ...(options.isDev ? [`${EXPO_GO_SCHEME}://`] : []),
  ]
}

/** Better Auth's session cookie; the Expo client stores it, the bearer plugin reads it. */
export const SESSION_COOKIE_NAME = "better-auth.session_token"

/**
 * The phone signs in through Better Auth's Expo plugin, which keeps the
 * session as a cookie in the Keychain (ADR 0032) rather than handing out a
 * token. The server's bearer plugin accepts that cookie's signed value
 * (`<token>.<signature>`, verified with `BETTER_AUTH_SECRET`) as
 * `Authorization: Bearer`, so the phone calls `/v1/me` and `/api/auth/token`
 * the same way the daemon does and no second token type exists.
 *
 * Takes the cookie string the plugin's `getCookie()` returns
 * (`name=value; name=value`) and returns the session's value, or null when
 * there is no session in it (signed out, or only cached session data).
 */
export function sessionTokenFromCookie(
  cookie: string | null | undefined
): string | null {
  if (!cookie) return null
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=")
    if (separator === -1) continue
    const name = part.slice(0, separator).trim()
    // Production cookies carry Better Auth's `__Secure-` prefix.
    if (
      name !== SESSION_COOKIE_NAME &&
      name !== `__Secure-${SESSION_COOKIE_NAME}`
    )
      continue
    const value = part.slice(separator + 1).trim()
    return value === "" ? null : value
  }
  return null
}

/** Better Auth's mount point on the API server. */
export const AUTH_BASE_PATH = "/api/auth"

/** `clientID` shared by the server and desktop Electron plugins. */
export const ELECTRON_CLIENT_ID = "orvilo-desktop"
/** OAuth client id the daemon sends to the device-authorization plugin. */
export const DAEMON_CLIENT_ID = "orvilo-daemon"
/**
 * Deep-link host of the desktop screen that approves a daemon's device code:
 * `orvilo[-dev]://device?user_code=ABCD-EFGH` (the device-authorization
 * plugin's verification_uri_complete).
 */
export const DEVICE_APPROVAL_DEEP_LINK_HOST = "device"

/**
 * Query parameter the desktop adds to the plugin's init-oauth-proxy URL so
 * the browser landing page knows which flavor's scheme to open.
 */
export const DESKTOP_SCHEME_PARAM = "scheme"

/** Where the outward MCP server (ADR 0034) is mounted on the API server. */
export const MCP_PATH = "/mcp"
/** OAuth scopes an MCP client can be granted (ADR 0034). */
export const MCP_SCOPES = ["mcp:read", "mcp:write"] as const
export type McpScope = (typeof MCP_SCOPES)[number]

/** Server-rendered pages of the OAuth flow MCP clients start in a browser. */
export const OAUTH_PAGES = {
  login: "/oauth/login",
  consent: "/oauth/consent",
} as const

export const AUTH_ROUTES = {
  /** Better Auth jwt plugin: short-lived JWT for zero-cache and the relay. */
  token: `${AUTH_BASE_PATH}/token`,
  /** Dev-only bypass (a Better Auth endpoint, so it sets the session cookie). */
  devLogin: `${AUTH_BASE_PATH}/dev/login`,
  me: "/v1/me",
} as const

/**
 * Settings › Login & security (ORV-179). JWT-authenticated: the desktop's
 * renderer never sees the session token. GET lists; DELETE revokes. A
 * session's own id comes from the JWT's `sid`, so the page can mark "this
 * session" without exposing session tokens.
 */
export const SECURITY_ROUTES = {
  sessions: "/v1/me/security/sessions",
  session: "/v1/me/security/sessions/:sessionId",
  devices: "/v1/me/security/devices",
  device: "/v1/me/security/devices/:deviceId",
  applications: "/v1/me/security/applications",
  application: "/v1/me/security/applications/:applicationId",
} as const

export const securityPaths = {
  sessions: () => SECURITY_ROUTES.sessions,
  session: (sessionId: string) =>
    `/v1/me/security/sessions/${encodeURIComponent(sessionId)}`,
  devices: () => SECURITY_ROUTES.devices,
  device: (deviceId: string) =>
    `/v1/me/security/devices/${encodeURIComponent(deviceId)}`,
  applications: () => SECURITY_ROUTES.applications,
  application: (applicationId: string) =>
    `/v1/me/security/applications/${encodeURIComponent(applicationId)}`,
}

/**
 * One signed-in browser or app session. Never carries the session token or
 * anything derived from it: the page only needs to recognise a session and
 * revoke it by id.
 */
export const activeSession = z.object({
  id: z.string(),
  /** ISO timestamps. */
  createdAt: z.string(),
  expiresAt: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** Derived from the caller's JWT (`sid`), not from the request's cookies. */
  current: z.boolean(),
})
export type ActiveSession = z.infer<typeof activeSession>

export const activeSessions = z.object({ sessions: z.array(activeSession) })

/** A machine whose daemon signed in with `orvilo daemon login`. */
export const authorizedDevice = z.object({
  id: z.uuid(),
  name: z.string(),
  hostname: z.string().nullable(),
  platform: z.string().nullable(),
  daemonVersion: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  /** The daemon session; null once the authorization is revoked. */
  sessionId: z.string().nullable(),
  /** When the daemon signed in, and when that session expires. */
  authorizedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
})
export type AuthorizedDevice = z.infer<typeof authorizedDevice>

export const authorizedDevices = z.object({
  devices: z.array(authorizedDevice),
})

/** A third-party MCP client the person granted access (ADR 0034). */
export const authorizedApplication = z.object({
  id: z.string(),
  name: z.string(),
  uri: z.string().nullable(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type AuthorizedApplication = z.infer<typeof authorizedApplication>

export const authorizedApplications = z.object({
  applications: z.array(authorizedApplication),
})

export const sessionUser = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  image: z.string().nullable(),
})
export type SessionUser = z.infer<typeof sessionUser>

/** A short-lived JWT for zero-cache and the relay. */
export const accessToken = z.object({
  token: z.string().min(1),
  /** Expiry, ms since epoch (from the JWT's `exp`). */
  expiresAt: z.number().int(),
})
export type AccessToken = z.infer<typeof accessToken>

/** Claims Orvilo adds to Better Auth JWTs. */
export interface OrviloJwtClaims {
  sub: string
  /** The Better Auth session the token was minted from (settings: "this session"). */
  sid?: string
  /** Set when an agent acts for the user. */
  act?: { agent_id?: string }
}
