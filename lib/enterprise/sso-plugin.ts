import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { sso, type SSOOptions, type SSOUserResolutionInput, type SSOUserResolutionContext } from '@better-auth/sso'
import type { BetterAuthPlugin, DBTransactionAdapter } from 'better-auth'
import type { DBFieldAttribute } from 'better-auth/db'
import { openSecret, sealSecret, type Sealed } from '../secrets/crypto'
import { identityTokenHash } from './scim-store'

export type EnterpriseLoginProof = { organizationId: string; providerId: string; directoryUserId: string | null; identityId: string; userId: string }
type Proof = EnterpriseLoginProof
const context = new AsyncLocalStorage<{ linkTicket?: string; proof?: Proof }>()
export function withEnterpriseAuthRequest(handler: (request: Request) => Promise<Response>) {
  return (request: Request) => {
    const ticket = /(?:^|;\s*)mikka-sso-link=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.get('cookie') ?? '')?.[1]
    return context.run({ linkTicket: ticket }, () => handler(request))
  }
}

export function ssoSessionData(userId: string) {
  const proof = context.getStore()?.proof
  if (!proof || proof.userId !== userId) return {}
  return { enterpriseOrganizationId: proof.organizationId, enterpriseProviderId: proof.providerId, enterpriseDirectoryUserId: proof.directoryUserId, enterpriseIdentityId: proof.identityId }
}
export const enterpriseSessionFields = {
  enterpriseOrganizationId: { type: 'string', required: false, input: false, returned: false },
  enterpriseProviderId: { type: 'string', required: false, input: false, returned: false },
  enterpriseDirectoryUserId: { type: 'string', required: false, input: false, returned: false },
  enterpriseIdentityId: { type: 'string', required: false, input: false, returned: false },
} as const

type Provider = { providerId: string; organizationScopeId: string; domainVerified: boolean; domain: string }
type Directory = { id: string; userId: string | null; userName: string; organizationId: string }
type Connection = { id: string; organizationId: string }
type LinkTicket = { userId: string; sessionId: string }
type Identity = { id: string; userId: string; directoryUserId: string | null }

async function consentedAccount(database: DBTransactionAdapter, providerId: string, email: string): Promise<string | null> {
  const ticketValue = context.getStore()?.linkTicket
  if (!ticketValue) return null
  const ticket = await database.consumeOne<LinkTicket>({ model: 'enterpriseLinkTicket', where: [
    { field: 'id', value: identityTokenHash(ticketValue) }, { field: 'providerId', value: providerId }, { field: 'expiresAt', operator: 'gt', value: new Date() },
  ] })
  if (!ticket) return null
  const session = await database.findOne<{ id: string }>({ model: 'session', where: [{ field: 'id', value: ticket.sessionId }, { field: 'userId', value: ticket.userId }, { field: 'expiresAt', operator: 'gt', value: new Date() }] })
  const user = await database.findOne<{ email: string; emailVerified: boolean }>({ model: 'user', where: [{ field: 'id', value: ticket.userId }] })
  return session && user?.emailVerified && user.email.toLowerCase() === email.toLowerCase() ? ticket.userId : null
}

/** The callback only sees cryptographically verified issuer/subject, never email-derived identity. */
export async function resolveEnterpriseIdentity(input: SSOUserResolutionInput, { database }: SSOUserResolutionContext) {
  const request = context.getStore()
  if (!request) return { action: 'reject' as const, code: 'ENTERPRISE_AUTH_CONTEXT_REQUIRED' }
  const provider = await database.findOne<Provider>({ model: 'ssoProvider', where: [{ field: 'providerId', value: input.providerId }] })
  if (!provider?.domainVerified || !provider.organizationScopeId) return { action: 'reject' as const, code: 'ENTERPRISE_PROVIDER_UNVERIFIED' }
  const email = input.providerUser.email.toLowerCase()
  if (email.split('@')[1] !== provider.domain) return { action: 'reject' as const, code: 'ENTERPRISE_EMAIL_DOMAIN_MISMATCH' }
  const where = [{ field: 'providerId', value: input.providerId }, { field: 'issuer', value: input.accountKey.issuer }, { field: 'subject', value: input.accountKey.accountId }]
  let identity = await database.findOne<Identity>({ model: 'enterpriseIdentity', where })
  const connection = await database.incrementOne<Connection>({ model: 'enterpriseScimConnection', where: [
    { field: 'providerId', value: input.providerId }, { field: 'organizationId', value: provider.organizationScopeId }, { field: 'revokedAt', value: null },
  ], increment: { fence: 1 } })
  let userId: string | null = identity?.userId ?? null
  let directory: Directory | null = null
  if (connection) {
    directory = await database.incrementOne<Directory>({ model: 'enterpriseScimUser', where: [
    { field: 'connectionId', value: connection.id }, { field: 'externalId', value: input.accountKey.accountId },
    { field: 'active', value: true }, { field: 'deleted', value: false },
  ], increment: { fence: 1 } })
    if (!directory) return { action: 'reject' as const, code: 'ENTERPRISE_DIRECTORY_INACTIVE' }
    if (!directory.userId) {
      // An existing signed issuer/subject binding may be adopted when SCIM is enabled later.
      const linked = identity?.userId ?? await consentedAccount(database, input.providerId, directory.userName)
      if (!linked) return { action: 'reject' as const, code: 'ENTERPRISE_ACCOUNT_LINK_REQUIRED' }
      await database.update({ model: 'enterpriseScimUser', where: [{ field: 'id', value: directory.id }], update: { userId: linked } })
      directory.userId = linked
    }
    userId = directory.userId
  } else {
    const managed = await database.findOne<{ id: string }>({ model: 'enterpriseScimConnection', where: [{ field: 'providerId', value: input.providerId }] })
    if (managed) return { action: 'reject' as const, code: 'ENTERPRISE_DIRECTORY_REVOKED' }
    if (!userId) {
      const existing = await database.findOne<{ id: string }>({ model: 'user', where: [{ field: 'email', value: email }] })
      if (existing) userId = await consentedAccount(database, input.providerId, email)
      else {
        const user = await database.create<Record<string, unknown>, { id: string }>({ model: 'user', forceAllowId: true,
          data: { id: randomUUID(), email, name: input.providerUser.name || email, emailVerified: input.providerUser.emailVerified, createdAt: new Date(), updatedAt: new Date() } })
        userId = user.id
      }
      if (!userId) return { action: 'reject' as const, code: 'ENTERPRISE_ACCOUNT_LINK_REQUIRED' }
    }
  }
  if (identity && (identity.userId !== userId || (identity.directoryUserId && identity.directoryUserId !== directory?.id)))
    return { action: 'reject' as const, code: 'ENTERPRISE_IDENTITY_CONFLICT' }
  if (!identity) identity = await database.create({ model: 'enterpriseIdentity', forceAllowId: true, data: {
    id: randomUUID(), providerId: input.providerId, issuer: input.accountKey.issuer, subject: input.accountKey.accountId,
    directoryUserId: directory?.id ?? null, userId,
  } })
  else if (directory && !identity.directoryUserId) await database.update({ model: 'enterpriseIdentity', where: [{ field: 'id', value: identity.id }], update: { directoryUserId: directory.id } })
  request.proof = { organizationId: provider.organizationScopeId, providerId: input.providerId, directoryUserId: directory?.id ?? null, identityId: identity.id, userId }
  return { action: 'link' as const, userId, profile: 'preserve' as const }
}

export async function completeEnterpriseSignIn(userId?: string) {
  const proof = context.getStore()?.proof
  if (proof && proof.userId === userId) await (await import('./lifecycle')).synchronizeEnterpriseLogin(proof)
}

export const configAAD = (field: 'oidcConfig' | 'samlConfig') => `mikka:enterprise-sso:${field}:v1`
export function encryptSsoConfig(value: unknown, field: 'oidcConfig' | 'samlConfig') {
  return JSON.stringify(sealSecret(typeof value === 'string' ? value : JSON.stringify(value), configAAD(field)))
}
export function decryptSsoConfig(value: string, field: 'oidcConfig' | 'samlConfig') {
  return openSecret(JSON.parse(value) as Sealed, configAAD(field))
}

/** Management is app-owned; native endpoints handle OIDC/SAML signatures, state, PKCE, replay and SLO. */
export function enterpriseSso(options: Pick<SSOOptions, 'defaultSSO'> = {}) {
  const plugin = sso({ ...options, modelName: 'enterprise_sso_provider', providersLimit: 0,
    organizationProvisioning: { disabled: true }, domainVerification: { enabled: true },
    trustEmailVerified: true, resolveUser: resolveEnterpriseIdentity,
    saml: { enableInResponseToValidation: true, allowIdpInitiated: false, enableSingleLogout: true, wantLogoutRequestSigned: true, wantLogoutResponseSigned: true },
    schema: { ssoProvider: { additionalFields: { organizationScopeId: { type: 'string', required: true, input: false, returned: false } } } },
  })
  for (const field of ['oidcConfig', 'samlConfig'] as const) {
    const definition = plugin.schema.ssoProvider.fields[field] as DBFieldAttribute
    definition.transform = { input: value => value == null ? value : encryptSsoConfig(value, field), output: value => value == null ? value : decryptSsoConfig(String(value), field) }
  }
  return plugin
}

const string = { type: 'string', required: true } as const
const optionalString = { type: 'string', required: false } as const
/** Extra adapter models allow the resolver fence and account/session creation to share one native transaction. */
export const enterpriseIdentityModels = {
  id: 'mikka-enterprise-identity',
  schema: {
    enterpriseScimConnection: { modelName: 'enterprise_scim_connection', fields: { organizationId: string, providerId: string, revokedAt: { type: 'date', required: false }, fence: { type: 'number', defaultValue: 0 } } },
    enterpriseScimUser: { modelName: 'enterprise_scim_user', fields: { connectionId: string, organizationId: string, externalId: string, userName: string, userId: optionalString,
      active: { type: 'boolean', required: true }, deleted: { type: 'boolean', required: true }, fence: { type: 'number', defaultValue: 0 } } },
    enterpriseIdentity: { modelName: 'enterprise_identity', fields: { providerId: string, issuer: string, subject: string, directoryUserId: optionalString, userId: string } },
    enterpriseLinkTicket: { modelName: 'enterprise_link_ticket', fields: { providerId: string, userId: string, sessionId: string, expiresAt: { type: 'date', required: true } } },
  },
} satisfies BetterAuthPlugin
