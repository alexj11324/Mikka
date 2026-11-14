import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
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
const domainFields = { id: organizationJoinDomains.id, domain: organizationJoinDomains.domain }
type Account = { id: string; email: string }

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
    if (existing) return { domain: existing }
    const [created] = await tx.insert(organizationJoinDomains).values({ id: randomUUID(), organizationId, domain }).returning(domainFields)
    await enqueueOrganizationAudit(tx, { organizationId, actorId: user.id, action: 'organization.join_domain_added', targetId: created.id })
    return { domain: created }
  })
}

export async function removeAllowedDomain(organizationId: string, domainId: string, userId: string) {
  z.uuid().parse(domainId)
  return workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, userId)
    const [removed] = await tx.delete(organizationJoinDomains)
      .where(and(eq(organizationJoinDomains.organizationId, organizationId), eq(organizationJoinDomains.id, domainId)))
      .returning({ id: organizationJoinDomains.id })
    if (removed) await enqueueOrganizationAudit(tx, { organizationId, actorId: userId, action: 'organization.join_domain_removed', targetId: removed.id })
    return { removed: true }
  })
}

export async function listJoinableOrganizations(user: Account, sessionId: string) {
  const account = await verifiedDomainUser(user)
  if (!account) return { organizations: [] }
  const candidates = await workspaceDb.select({ id: organizations.id, name: organizations.name }).from(organizationJoinDomains)
    .innerJoin(organizations, eq(organizations.id, organizationJoinDomains.organizationId))
    .leftJoin(organizationMembers, and(eq(organizationMembers.organizationId, organizations.id), eq(organizationMembers.userId, user.id)))
    .where(and(eq(organizationJoinDomains.domain, account.domain), isNull(organizations.archivedAt), isNull(organizationMembers.userId)))
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
      .where(and(eq(organizationJoinDomains.organizationId, organizationId), eq(organizationJoinDomains.domain, account.domain)))
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
