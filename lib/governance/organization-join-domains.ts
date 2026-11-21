import 'server-only'
import { randomUUID } from 'node:crypto'
import { resolveTxt } from 'node:dns/promises'
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm'
import publicEmailDomains from 'free-email-domains'
import { z } from 'zod'
import { disposableEmail } from '@/lib/abuse/signup'
import { pool } from '@/lib/db'
import { organizationJoinDomains, organizationMembers, organizations } from '@/lib/db/governance-schema'
import { requireEnterpriseOrganization } from '@/lib/enterprise/access'
import { WorkspaceError } from '@/lib/workspace-error'
import { workspaceDb } from '@/lib/workspace-db'
import { enqueueOrganizationAudit } from './audit'
import { GovernanceError } from './errors'
import { assertOrganizationAccountWritable } from './organization-ownership'
import { requireOrganizationAdmin } from './organizations'

const publicDomains = new Set<string>(publicEmailDomains)
const domainInput = z.object({ domain: z.string().trim().toLowerCase().max(253).pipe(z.hostname()) }).strict()
const domainFields = {
  id: organizationJoinDomains.id,
  domain: organizationJoinDomains.domain,
  createdByUserId: organizationJoinDomains.createdByUserId,
  createdAt: organizationJoinDomains.createdAt,
  verifiedAt: organizationJoinDomains.verifiedAt,
  lastCheckedAt: organizationJoinDomains.lastCheckedAt,
  verificationError: organizationJoinDomains.verificationError,
  // Grants are immutable. Adding a removed domain creates a new grant.
  updatedAt: organizationJoinDomains.createdAt,
}
type Account = { id: string; email: string }

/** This public DNS challenge proves control of this domain for this exact organization grant. */
export function organizationDomainRecord(organizationId: string, domain: { id: string; domain: string }) {
  return { type: 'TXT' as const, name: `_mikka-domain.${domain.domain}`, value: `mikka-domain=${organizationId}:${domain.id}` }
}

export async function verifyAllowedDomain(organizationId: string, domainId: string, userId: string) {
  z.uuid().parse(domainId)
  const domain = await workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, userId)
    const [row] = await tx.select(domainFields).from(organizationJoinDomains)
      .where(and(eq(organizationJoinDomains.organizationId, organizationId), eq(organizationJoinDomains.id, domainId)))
    if (!row) throw new GovernanceError('not_found')
    return row
  })
  const dns = organizationDomainRecord(organizationId, domain)
  let verificationError: 'record_missing' | 'lookup_failed' | null = null
  try {
    const records = await resolveTxt(dns.name)
    if (!records.some(parts => parts.join('') === dns.value)) verificationError = 'record_missing'
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    verificationError = code === 'ENODATA' || code === 'ENOTFOUND' ? 'record_missing' : 'lookup_failed'
  }
  return workspaceDb.transaction(async tx => {
    // No DNS request holds a database lock. Recheck administrator and grant after it completes.
    await requireOrganizationAdmin(tx, organizationId, userId)
    const checkedAt = new Date()
    const [updated] = await tx.update(organizationJoinDomains).set({
      lastCheckedAt: checkedAt, verifiedAt: verificationError ? null : checkedAt, verificationError,
    }).where(and(eq(organizationJoinDomains.organizationId, organizationId),
      eq(organizationJoinDomains.id, domainId), eq(organizationJoinDomains.domain, domain.domain))).returning(domainFields)
    if (!updated) throw new GovernanceError('not_found')
    await enqueueOrganizationAudit(tx, { organizationId, actorId: userId, action: 'organization.join_domain_checked',
      targetId: domainId, result: verificationError ? 'failure' : 'success', metadata: { reason: verificationError, enabled: !verificationError } })
    return { domain: updated, dns, verified: !verificationError }
  })
}

async function verifiedDomainUser(user: Account) {
  const { rows: [account] } = await pool.query<{ name: string; email: string }>(
    'select name,lower(email) as email from "user" where id=$1 and "emailVerified" and lower(email)=lower($2)', [user.id, user.email])
  if (!account) return null
  const domain = account.email.split('@')[1]
  if (!domain || !domain.includes('.') || !z.hostname().safeParse(domain).success || publicDomains.has(domain) || disposableEmail(account.email))
    return null
  return { ...account, domain }
}

export async function listAllowedDomains(organizationId: string, userId: string) {
  return workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, userId)
    const domains = await tx.select(domainFields).from(organizationJoinDomains)
      .where(eq(organizationJoinDomains.organizationId, organizationId)).orderBy(asc(organizationJoinDomains.domain))
    return { domains }
  })
}

export async function addAllowedDomain(organizationId: string, user: Account, input: unknown) {
  const { domain } = domainInput.parse(input)
  return workspaceDb.transaction(async tx => {
    await assertOrganizationAccountWritable(tx, user.id)
    await requireOrganizationAdmin(tx, organizationId, user.id)
    if ((await verifiedDomainUser(user))?.domain !== domain) throw new GovernanceError('access_denied')
    const [existing] = await tx.select(domainFields).from(organizationJoinDomains)
      .where(and(eq(organizationJoinDomains.organizationId, organizationId), eq(organizationJoinDomains.domain, domain)))
    if (existing) return { domain: existing, dns: organizationDomainRecord(organizationId, existing) }
    const id = randomUUID()
    await tx.insert(organizationJoinDomains).values({ id, organizationId, domain })
    await enqueueOrganizationAudit(tx, { organizationId, actorId: user.id, action: 'organization.join_domain_added', targetId: id })
    const [created] = await tx.select(domainFields).from(organizationJoinDomains).where(eq(organizationJoinDomains.id, id))
    return { domain: created, dns: organizationDomainRecord(organizationId, created) }
  })
}

export async function removeAllowedDomain(organizationId: string, domainId: string, userId: string) {
  z.uuid().parse(domainId)
  return workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, userId)
    const [removed] = await tx.delete(organizationJoinDomains)
      .where(and(eq(organizationJoinDomains.organizationId, organizationId), eq(organizationJoinDomains.id, domainId)))
      .returning(domainFields)
    if (removed) await enqueueOrganizationAudit(tx, { organizationId, actorId: userId, action: 'organization.join_domain_removed', targetId: removed.id })
    return { removed: true, domain: removed ?? null }
  })
}

export async function listJoinableOrganizations(user: Account, sessionId: string) {
  const account = await verifiedDomainUser(user)
  if (!account) return { organizations: [] }
  const candidates = await workspaceDb.select({ id: organizations.id, name: organizations.name }).from(organizationJoinDomains)
    .innerJoin(organizations, eq(organizations.id, organizationJoinDomains.organizationId))
    .leftJoin(organizationMembers, and(eq(organizationMembers.organizationId, organizations.id), eq(organizationMembers.userId, user.id)))
    .where(and(eq(organizationJoinDomains.domain, account.domain), isNotNull(organizationJoinDomains.verifiedAt),
      isNull(organizations.archivedAt), isNull(organizationMembers.userId)))
    .orderBy(asc(organizations.name), asc(organizations.id))
  const visible = []
  for (const candidate of candidates) {
    try { await requireEnterpriseOrganization(user.id, candidate.id, sessionId) } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'workspaceAccessDenied') continue
      throw error
    }
    visible.push(candidate)
  }
  return { organizations: visible }
}

export async function joinOrganizationByDomain(organizationId: string, user: Account, sessionId: string) {
  return workspaceDb.transaction(async tx => {
    await assertOrganizationAccountWritable(tx, user.id)
    // Removing a domain, removing a member and accepting invitations share this Organization lock.
    const [org] = await tx.select({ archivedAt: organizations.archivedAt }).from(organizations)
      .where(eq(organizations.id, organizationId)).for('update')
    if (!org || org.archivedAt) throw new GovernanceError('access_denied')
    await requireEnterpriseOrganization(user.id, organizationId, sessionId)
    const account = await verifiedDomainUser(user)
    if (!account) throw new GovernanceError('access_denied')
    const [allowed] = await tx.select({ id: organizationJoinDomains.id }).from(organizationJoinDomains)
      .where(and(eq(organizationJoinDomains.organizationId, organizationId), eq(organizationJoinDomains.domain, account.domain),
        isNotNull(organizationJoinDomains.verifiedAt)))
    if (!allowed) throw new GovernanceError('access_denied')
    const [member] = await tx.select({ status: organizationMembers.status, role: organizationMembers.role }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, user.id)))
    if (member?.status === 'suspended') throw new GovernanceError('access_denied')
    if (member) return { organizationId, joined: true, role: member.role }
    await tx.insert(organizationMembers).values({ organizationId, userId: user.id, name: account.name, email: account.email, role: 'member' })
    await enqueueOrganizationAudit(tx, { organizationId, actorId: user.id, action: 'organization.member_joined_by_domain', targetId: allowed.id, metadata: { role: 'member' } })
    return { organizationId, joined: true, role: 'member' as const }
  })
}
