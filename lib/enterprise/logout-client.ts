import { withBasePath } from '@/lib/base-path'
import type { EnterpriseLogoutTarget } from './logout-target'

export type { EnterpriseLogoutTarget }

/**
 * The sign-out route of the current session (#1642, #1669):
 * GET /api/enterprise/logout-target answers `{ target: null }` or
 * `{ target: { providerId, protocol } }`, no-store. It only picks the route;
 * it grants nothing and says nothing about workspaces or sign-in.
 */
export const LOGOUT_TARGET_PATH = '/api/enterprise/logout-target'

export class LogoutTargetError extends Error {
  constructor(readonly status: number) { super(`logout_target_${status}`); this.name = 'LogoutTargetError' }
}

/** The descriptor, or undefined when the body is not one (never guessed into a route). */
export function parseLogoutTarget(value: unknown): EnterpriseLogoutTarget | null | undefined {
  if (!value || typeof value !== 'object' || !('target' in value)) return undefined
  const target = (value as { target: unknown }).target
  if (target === null) return null
  if (!target || typeof target !== 'object') return undefined
  const { providerId, protocol } = target as Record<string, unknown>
  if (typeof providerId !== 'string' || !providerId || providerId.length > 200) return undefined
  if (protocol !== 'oidc' && protocol !== 'saml') return undefined
  return { providerId, protocol }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** Reads the route for this browser's cookie session. Throws on a refusal or a malformed answer. */
export async function readLogoutTarget(fetchImpl: Fetch = (input, init) => fetch(input, init)): Promise<EnterpriseLogoutTarget | null> {
  const response = await fetchImpl(withBasePath(LOGOUT_TARGET_PATH), { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new LogoutTargetError(response.status)
  const target = parseLogoutTarget(await response.json().catch(() => undefined))
  if (target === undefined) throw new LogoutTargetError(response.status)
  return target
}

export const oidcLogoutPath = (providerId: string) => `/api/auth/sso/oidc/logout/${encodeURIComponent(providerId)}`
export const samlLogoutPath = (providerId: string) => `/api/auth/sso/saml2/logout/${encodeURIComponent(providerId)}`

/**
 * What the browser does next:
 * - OIDC: the POST answers 200 JSON `{ url, localSessionRevoked, upstream }`
 *   after revoking the local session; the browser goes to `url`.
 * - SAML: the POST answers the original 302 to the IdP. That is a top-level
 *   form POST the browser follows itself; it is never read as OIDC JSON.
 */
export type EnterpriseSignOutStep =
  | { kind: 'navigate'; url: string; upstream: string }
  | { kind: 'form'; action: string; fields: Record<string, string> }

export class EnterpriseSignOutError extends Error {
  constructor(readonly status: number) { super(`enterprise_sign_out_${status}`); this.name = 'EnterpriseSignOutError' }
}

/** A navigation target from the server: http(s) only, anything else is refused. */
function navigable(value: unknown, base: string): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value, base)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch { return null }
}

export async function enterpriseSignOutStep(target: EnterpriseLogoutTarget, options: { origin: string; fetch?: Fetch }): Promise<EnterpriseSignOutStep> {
  if (target.protocol === 'saml') {
    // Where the IdP returns after Single Logout; the server checks it is a trusted origin.
    return { kind: 'form', action: withBasePath(samlLogoutPath(target.providerId)), fields: { callbackURL: `${options.origin}${withBasePath('/sign-in?login=1')}` } }
  }
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  const response = await fetchImpl(withBasePath(oidcLogoutPath(target.providerId)), {
    method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  const value = await response.json().catch(() => null) as { url?: unknown; upstream?: unknown; localSessionRevoked?: unknown } | null
  const url = navigable(value?.url, options.origin)
  if (!response.ok || value?.localSessionRevoked !== true || !url) throw new EnterpriseSignOutError(response.status)
  return { kind: 'navigate', url, upstream: typeof value.upstream === 'string' ? value.upstream : 'unavailable' }
}

/** Submits a top-level POST form, so the browser follows the SAML 302 itself. */
export function submitSignOutForm(step: Extract<EnterpriseSignOutStep, { kind: 'form' }>, doc: Document = document) {
  const form = doc.createElement('form')
  form.method = 'POST'
  form.action = step.action
  form.hidden = true
  for (const [name, value] of Object.entries(step.fields)) {
    const input = doc.createElement('input')
    input.type = 'hidden'; input.name = name; input.value = value
    form.append(input)
  }
  doc.body.append(form)
  form.submit()
}
