'use client'

import useSWR, { unstable_serialize } from 'swr'
import { useTranslations } from 'next-intl'
import type { SharedResourceKind } from '@/lib/db/governance-schema'
import { withBasePath } from '@/lib/base-path'
import { authClient } from '@/lib/auth-client'
import { ORGANIZATION_MODEL_PROVIDERS } from '@/lib/governance/policy'
import { GovernanceRequestError, governanceKey, type GovernanceDetail } from '@/hooks/settings/use-workspace-governance'
import { useLiveKey, useLiveKeys } from '@/hooks/use-live-key'

/**
 * Enterprise v1 (#1608 P2, #1642 「Claude 界面交接」): the Organization a Shared
 * workspace is bound to. An Organization role is administrative only: it never
 * grants a Workspace, Task, Factory, Artifact or MCP access, and Workspace
 * membership stays in 成员. Every read and write goes to the server, which
 * repeats role, licence and SSO checks; nothing here is optimistic. The
 * open-source UI draws none of it (slot `settings-organization`).
 */

export type OrganizationRole = 'owner' | 'admin' | 'member'
export type OrganizationListItem = { id: string; name: string; role: OrganizationRole }
export type JoinableOrganization = Pick<OrganizationListItem, 'id' | 'name'>
export type OrganizationDomain = { id: string; domain: string }
export type OrganizationMember = { organizationId: string; userId: string; role: OrganizationRole; status: 'active' | 'suspended'; name: string; email: string; createdAt: string; updatedAt: string }
/** Organization membership only; invitations never confer Workspace/Project access. */
export type OrganizationInvitation = {
  id: string; email: string; createdBy: string; status: 'pending' | 'accepted' | 'revoked'
  createdAt: string; expiresAt: string
}
export type OrganizationInvitationOutcome =
  | { email: string; created: true; id: string; path: string }
  | { email: string; created: false; reason: 'duplicate' | 'alreadyMember' | 'pending' }
type ReceivedOrganizationInvitation = { id: string; organizationName: string; expiresAt: string }
export type OrganizationAuditEvent = {
  id: string; organizationId?: string; actorId: string; action: string; result: 'success' | 'denied' | 'failure'
  correlationId?: string; targetId: string | null; metadata: Record<string, string | number | boolean | null>; createdAt: string
}
export type OrganizationSummary = {
  organization: { id: string; name: string; createdBy: string; createdAt: string; updatedAt: string; archivedAt: string | null }
  role: OrganizationRole
  members: OrganizationMember[]
  workspaceIds: string[]
  /** Distinct active people across every bound workspace. */
  activeHumans: number
  /** The latest 100 Organization events. */
  audit: OrganizationAuditEvent[]
}

export type IdentityProvider = { providerId: string; domain: string; domainVerified: boolean; protocol: 'oidc' | 'saml'; createdAt: string; updatedAt: string }
export type ScimConnection = { id: string; providerId: string; revokedAt: string | null; createdAt: string }
export type IdentitySummary = { providers: IdentityProvider[]; connections: ScimConnection[]; policy: { enforceSso: boolean; allowMachineCredentials: boolean } }

export type OidcProviderInput = {
  action: 'configure-provider'; protocol: 'oidc'; providerId: string; domain: string
  issuer: string; clientId: string; clientSecret: string; tokenEndpointAuthentication?: 'client_secret_basic' | 'client_secret_post'
}
export type SamlProviderInput = {
  action: 'configure-provider'; protocol: 'saml'; providerId: string; domain: string
  issuer: string; idpEntityId: string; entryPoint: string; cert: string | string[]
  logoutEntryPoint?: string; logoutPostEntryPoint?: string
  spSigning?: { cert: string; privateKey: string; passphrase?: string }
  mapping?: { email: string; name?: string }
}
/** What to register at the IdP and publish in DNS. `dns.token` proves the domain once; it is shown only in this response. */
export type ProviderConfigured = { providerId: string; dns: { type: 'TXT'; name: string; value: string; token: string }; callbackURL: string; postLogoutRedirectURI?: string }
/** Shown once: the SCIM bearer is never returned again. */
export type ScimCredential = { id: string; token: string; baseURL: string }

export type SharingRule = 'allow' | 'approval_required' | 'deny'
export const MODEL_PROVIDERS = ORGANIZATION_MODEL_PROVIDERS
export type ModelProvider = typeof MODEL_PROVIDERS[number]
export type ResourcePolicy = {
  modelCredentialSharing: SharingRule; mcpSharing: SharingRule
  /** null: every provider. */
  allowedModelProviders: ModelProvider[] | null
  /** null: kept until removed by hand. */
  auditRetentionDays: number | null
  legalHold: boolean
  revision: number
}
export type ResourceApproval = {
  id: string; organizationId: string; workspaceId: string; kind: SharedResourceKind; resourceId: string
  ownerId: string; status: 'pending' | 'approved' | 'denied'; decidedBy: string | null; createdAt: string; updatedAt: string
}
export type ResourcePolicyState = { policy: ResourcePolicy; approvals: ResourceApproval[] }

export type AuditManifest = { format: 'mikka-organization-audit-export'; version: 1; id: string; organizationId: string; createdAt: string; expiresAt: string; from: string; until: string; count: number; digest: string }
export type AuditExportPage = { manifest: AuditManifest; events: OrganizationAuditEvent[]; nextOffset: number | null }
export type AuditExportDetail = 'auditExportLimitExceeded' | 'auditExportUnavailable' | 'auditExportChanged'

/** A refusal from the audit export routes, which answer with their own code instead of governance_denied. */
export class AuditExportRequestError extends Error {
  constructor(public status: number, public code: AuditExportDetail | 'default') { super(code); this.name = 'AuditExportRequestError' }
}

const org = (id: string, path = '') => `/api/organizations/${encodeURIComponent(id)}${path}`

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(url), { cache: 'no-store', credentials: 'same-origin', ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; detail?: GovernanceDetail } } | null
    const code = body?.error?.code
    if (code === 'auditExportLimitExceeded' || code === 'auditExportUnavailable' || code === 'auditExportChanged') throw new AuditExportRequestError(response.status, code)
    throw new GovernanceRequestError(response.status, body?.error?.detail ?? 'default')
  }
  return response.json() as Promise<T>
}
const send = <T>(url: string, method: string, body?: unknown) => request<T>(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const swr = { shouldRetryOnError: false, revalidateOnFocus: false } as const

/** The message for a refusal: governance copy from the backend (RunErrors.governance_denied), audit export copy from Organization. */
export function useOrganizationErrorText() {
  const governance = useTranslations('RunErrors.governance_denied')
  const audit = useTranslations('Organization.audit.errors')
  return (error: unknown) => {
    if (error instanceof AuditExportRequestError) return audit.has(error.code as never) ? audit(error.code as never) : audit('default')
    const detail = error instanceof GovernanceRequestError ? error.detail : 'default'
    return governance.has(detail as never) ? governance(detail as never) : governance('default')
  }
}

export const organizationsKey = ['organizations'] as const
export const organizationKey = (id: string) => ['organization', id] as const
export const organizationInvitationsKey = (id: string) => ['organization-invitations', id] as const
export const identityKey = (id: string) => ['organization-identity', id] as const
export const policyKey = (id: string) => ['organization-policy', id] as const

/**
 * The 组织 page's reads follow the existing `workspace_settings` invalidation
 * of the workspace it is open for (membership, seats, governance templates),
 * like the member list; no polling of its own. Its own actions still re-read
 * what they changed.
 */
export function useOrganizationLive(workspaceId: string, organizationId: string | null | undefined) {
  const keys = [governanceKey(workspaceId), organizationsKey, ...(organizationId ? [organizationKey(organizationId), organizationInvitationsKey(organizationId), identityKey(organizationId), policyKey(organizationId)] : [])]
  useLiveKey('workspace_settings', workspaceId, keys.map(key => unstable_serialize(key)), workspaceId, { minIntervalMs: 2_000 })
}

/** Organizations the signed-in person belongs to, with their role in each. */
export function useOrganizations(enabled = true) {
  return useSWR(enabled ? organizationsKey : null, () => request<{ organizations: OrganizationListItem[] }>('/api/organizations').then(value => value.organizations), swr)
}

export function useJoinableOrganizations() {
  const { data, isPending } = authClient.useSession()
  // Desktop projects the public identity without emailVerified. The API checks the current verified email.
  return useSWR(isPending || !data || data.user.emailVerified === false ? null : ['joinable-organizations', data.user.id, data.user.email],
    () => request<{ organizations: JoinableOrganization[] }>('/api/me/joinable-organizations').then(value => value.organizations))
}

export function useReceivedOrganizationInvitations() {
  const { data, isPending } = authClient.useSession()
  return useSWR(isPending || !data || data.user.emailVerified === false ? null : ['received-organization-invitations', data.user.id, data.user.email, data.session.id],
    () => request<{ invitations: ReceivedOrganizationInvitation[] }>('/api/me/invitations').then(value => value.invitations))
}

export function useOrganizationDomains(organizationId: string) {
  const { data, isPending } = authClient.useSession()
  return useSWR(isPending || !data ? null : ['organization-domains', organizationId, data.user.id],
    () => request<{ domains: OrganizationDomain[] }>(org(organizationId, '/allowed-domains')).then(value => value.domains))
}

/** Members, bound workspaces, seats and recent events. 403 for anyone who is not an Organization owner or admin. */
export function useOrganizationSummary(organizationId: string | null | undefined) {
  return useSWR(organizationId ? organizationKey(organizationId) : null, ([, id]) => request<OrganizationSummary>(org(id)), swr)
}

/** Uses Organization membership, not Workspace admin privilege. No polling. */
export function useOrganizationInvitations(organizationId: string | null | undefined) {
  return useSWR(organizationId ? organizationInvitationsKey(organizationId) : null,
    ([, id]) => request<{ invitations: OrganizationInvitation[] }>(org(id, '/invitations')).then(value => value.invitations), swr)
}

export function useOrganizationIdentity(organizationId: string | null | undefined) {
  return useSWR(organizationId ? identityKey(organizationId) : null, ([, id]) => request<IdentitySummary>(org(id, '/identity')), swr)
}

export function useOrganizationPolicy(organizationId: string | null | undefined) {
  return useSWR(organizationId ? policyKey(organizationId) : null, ([, id]) => request<ResourcePolicyState>(org(id, '/policy')), swr)
}

export function useOrganizationServiceKeys(organizationId: string, after: string | undefined, workspaceIds: readonly string[]) {
  const key = ['organization-service-keys', organizationId, after ?? ''] as const
  const result = useSWR(key, () => organizationApi.serviceKeys(organizationId, after), swr)
  const subscriptions = workspaceIds.map(id => ({ kind: 'workspace_settings' as const, id, workspaceId: id }))
  useLiveKeys(subscriptions, [unstable_serialize(key)], undefined, { minIntervalMs: 2_000 })
  return result
}

export type OrganizationServiceKey = {
  id: string; name: string | null; workspaceId: string; serviceIdentityId: string; serviceIdentityName: string; expiresAt: string | null
}

export const organizationApi = {
  acceptReceivedInvitation: (invitationId: string) =>
    send<{ organizationId: string; joined: true }>('/api/organization-invitations/accept', 'POST', { invitationId }),
  addDomain: (id: string, domain: string) =>
    send<{ domain: OrganizationDomain }>(org(id, '/allowed-domains'), 'POST', { domain }),
  removeDomain: (id: string, domainId: string) =>
    send<{ removed: true }>(org(id, '/allowed-domains/' + encodeURIComponent(domainId)), 'DELETE'),
  joinByDomain: (id: string) =>
    send<{ organizationId: string; joined: true; role: OrganizationRole }>(org(id, '/join-by-domain'), 'POST'),
  serviceKeys: (id: string, after?: string) => request<{ keys: OrganizationServiceKey[]; nextCursor: string | null }>(
    org(id, '/api-keys') + (after ? '?' + new URLSearchParams({ after }) : '')),
  nameServiceKey: (id: string, keyId: string, name: string) =>
    send<{ id: string; name: string }>(org(id, '/api-keys/' + encodeURIComponent(keyId)), 'PATCH', { name }),
  create: (name: string) => send<OrganizationListItem>('/api/organizations', 'POST', { name }),
  rename: (id: string, name: string) => send<{ organization: OrganizationSummary['organization'] }>(org(id), 'PATCH', { name }),
  /** Owner only; needs every workspace unbound and every provider and SCIM connection closed first. */
  archive: (id: string) => send<{ archived: true }>(org(id), 'DELETE'),
  /** Binding needs both Organization admin and admin of that workspace. */
  bind: (id: string, workspaceId: string) => send<{ attached: true }>(org(id, '/workspaces'), 'POST', { workspaceId }),
  unbind: (id: string, workspaceId: string) => send<{ detached: true }>(org(id, '/workspaces'), 'DELETE', { workspaceId }),
  /** All emails invite an ordinary Organization Member only, never a Workspace member. */
  inviteMembers: (id: string, emails: string[]) =>
    send<{ outcomes: OrganizationInvitationOutcome[] }>(org(id, '/invitations'), 'POST', { emails }),
  revokeInvitation: (id: string, invitationId: string) =>
    send<{ revoked: true }>(org(id, '/invitations'), 'DELETE', { invitationId }),
  acceptInvitation: (token: string) =>
    send<{ organizationId: string; joined: true; role: 'member' }>('/api/organization-invitations/accept', 'POST', { token }),
  /** An existing account, chosen by ID; an email match alone adds no one. */
  addMember: (id: string, userId: string, role: OrganizationRole) => send<{ member: OrganizationMember }>(org(id, '/members'), 'POST', { userId, role }),
  setRole: (id: string, userId: string, role: OrganizationRole) => send<{ updated: true }>(org(id, '/members'), 'PATCH', { userId, role }),
  /** Scoped offboarding: suspends the person in this Organization's workspaces; their account and other Organizations stay. */
  removeMember: (id: string, userId: string) => send<{ removed: true }>(org(id, '/members'), 'DELETE', { userId }),

  configureProvider: (id: string, input: OidcProviderInput | SamlProviderInput) => send<ProviderConfigured>(org(id, '/identity'), 'POST', input),
  verifyDomain: (id: string, providerId: string, token: string) => send<{ verified: true }>(org(id, '/identity'), 'POST', { action: 'verify-domain', providerId, token }),
  disableProvider: (id: string, providerId: string) => send<{ disabled: true }>(org(id, '/identity'), 'POST', { action: 'disable-provider', providerId }),
  rotateScim: (id: string, providerId: string) => send<ScimCredential>(org(id, '/identity'), 'POST', { action: 'rotate-scim', providerId }),
  revokeScim: (id: string, connectionId: string) => send<{ revoked: true }>(org(id, '/identity'), 'POST', { action: 'revoke-scim', connectionId }),
  /** Turning SSO enforcement on needs the current session to be this Organization's SSO sign-in. */
  setSignInPolicy: (id: string, enforceSso: boolean, allowMachineCredentials: boolean) => send<IdentitySummary['policy']>(org(id, '/identity'), 'POST', { action: 'policy', enforceSso, allowMachineCredentials }),
  /** Owner only, within five minutes of signing in; lasts fifteen minutes. */
  breakGlass: (id: string, reason: string) => send<{ expiresAt: string }>(org(id, '/identity'), 'POST', { action: 'break-glass', reason }),
  retryRevocations: (id: string) => send<{ retried: true }>(org(id, '/identity'), 'POST', { action: 'retry-revocations' }),

  setPolicy: (id: string, policy: Omit<ResourcePolicy, 'revision'>) => send<ResourcePolicyState>(org(id, '/policy'), 'PATCH', policy),
  decide: (id: string, approvalId: string, status: 'approved' | 'denied') => send<{ decided: true }>(org(id, '/approvals'), 'PATCH', { id: approvalId, status }),

  /** Freezes the events in range for fifteen minutes; each page rechecks admin access and integrity. */
  createAuditExport: (id: string, range: { from?: string; until?: string }) => send<{ manifest: AuditManifest; events: OrganizationAuditEvent[] }>(org(id, '/audit-log'), 'POST', range),
  readAuditExport: (id: string, exportId: string, offset: number, limit = 100) =>
    request<AuditExportPage>(`${org(id, '/audit-log')}?${new URLSearchParams({ exportId, offset: String(offset), limit: String(limit) })}`),
}

/**
 * Account linking for someone who already has a Mikka account with the
 * directory's email: within five minutes of signing in, ask for a one-use
 * ticket, then sign in through the provider. Only that signed sign-in links.
 */
export async function linkExistingAccount(providerId: string, callbackURL: string) {
  await send<{ providerId: string; next: string }>('/api/enterprise/link', 'POST', { providerId })
  return signInWithSso({ providerId }, callbackURL)
}


/** Which company sign-in to start: a known method, or the one registered for an email's or a domain's verified domain. */
export type SsoTarget = { providerId: string } | { email: string } | { domain: string }

/**
 * Starts company sign-in (Better Auth SSO, /sign-in/sso) and returns where to
 * send the browser. Throws `SsoStartError` when no verified method matches.
 */
export async function signInWithSso(target: SsoTarget, callbackURL: string, errorCallbackURL?: string) {
  const response = await fetch(withBasePath('/api/auth/sign-in/sso'), { method: 'POST', cache: 'no-store', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...target, callbackURL, ...(errorCallbackURL ? { errorCallbackURL } : {}) }) })
  const value = await response.json().catch(() => null) as { url?: string } | null
  if (!response.ok || !value?.url) throw new SsoStartError(response.status)
  return value.url
}

/** No verified company sign-in for that email or domain (404), or the request was refused. */
export class SsoStartError extends Error {
  constructor(public status: number) { super(status === 404 ? 'not_found' : 'failed'); this.name = 'SsoStartError' }
}

/** OIDC RP-initiated logout for the provider of the current session (the server checks it matches). `upstream` says how far it got; local sign-out has happened in every case. */
export async function oidcSignOut(providerId: string) {
  return send<{ localSessionRevoked: true; upstream: 'requested' | 'not_supported' | 'unavailable'; url: string }>(`/api/auth/sso/oidc/logout/${encodeURIComponent(providerId)}`, 'POST', {})
}
