import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { organizationInvitations, organizationMembers, organizations } from '@/lib/db/governance-schema'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import { enqueueOrganizationAudit } from './audit'
import { GovernanceError } from './errors'
import { assertOrganizationAccountWritable } from './organization-ownership'

const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/)
const invitationIdSchema = z.uuid()
const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
const emailSchema = z.email().max(254)

export type OrganizationInvitationOutcome =
  | { email: string; created: true; id: string; path: string }
  | { email: string; created: false; reason: 'duplicate' | 'alreadyMember' | 'pending' }

function emailsFromInput(input: unknown): string[] {
  const { emails } = z.object({ emails: z.array(z.string()).min(1).max(20) }).strict().parse(input)
  return emails.map(email => emailSchema.parse(email.trim().toLowerCase()))
}

/** An Organization membership never grants access to an attached Workspace or Project. */
async function requireActiveOrganizationMember(tx: WorkspaceTransaction, organizationId: string, actorId: string) {
  invitationIdSchema.parse(organizationId)
  const [organization] = await tx.select({ id: organizations.id, archivedAt: organizations.archivedAt })
    .from(organizations).where(eq(organizations.id, organizationId)).for('update').limit(1)
  if (!organization || organization.archivedAt) throw new GovernanceError('access_denied')
  const [membership] = await tx.select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, actorId),
      eq(organizationMembers.status, 'active'))).limit(1)
  if (!membership) throw new GovernanceError('access_denied')
  return membership
}

/** All issued roles are Member; an ordinary member cannot create an admin/owner invitation. */
export async function issueOrganizationInvitations(organizationId: string, actorId: string, input: unknown) {
  const emails = emailsFromInput(input)
  return workspaceDb.transaction(async tx => {
    // Account deletion guards precede the Organization row lock (same order as member admission).
    await assertOrganizationAccountWritable(tx, actorId)
    await requireActiveOrganizationMember(tx, organizationId, actorId)
    const members = new Set((await tx.select({ email: organizationMembers.email }).from(organizationMembers)
      .where(eq(organizationMembers.organizationId, organizationId))).map(row => row.email.toLowerCase()))
    const existing = new Map((await tx.select().from(organizationInvitations)
      .where(eq(organizationInvitations.organizationId, organizationId))).map(row => [row.email, row]))
    const seen = new Set<string>()
    const outcomes: OrganizationInvitationOutcome[] = []
    const now = new Date()
    for (const email of emails) {
      if (seen.has(email)) { outcomes.push({ email, created: false, reason: 'duplicate' }); continue }
      seen.add(email)
      if (members.has(email)) { outcomes.push({ email, created: false, reason: 'alreadyMember' }); continue }
      const previous = existing.get(email)
      if (previous?.status === 'pending' && previous.expiresAt > now) {
        outcomes.push({ email, created: false, reason: 'pending' })
        continue
      }
      const token = randomBytes(32).toString('hex')
      const id = previous?.id ?? randomUUID()
      const expiresAt = new Date(now.getTime() + sevenDaysMs)
      await tx.insert(organizationInvitations).values({
        id, organizationId, createdBy: actorId, email, tokenHash: hashToken(token), expiresAt,
      }).onConflictDoUpdate({
        target: [organizationInvitations.organizationId, organizationInvitations.email],
        set: { createdBy: actorId, tokenHash: hashToken(token), status: 'pending', acceptedBy: null,
          expiresAt, createdAt: now, updatedAt: now },
      })
      await enqueueOrganizationAudit(tx, {
        organizationId, actorId, action: 'organization.member_invited', targetId: id,
        metadata: { role: 'member', status: 'pending' },
      })
      outcomes.push({ email, created: true, id, path: '/organization-invite/' + token })
    }
    return { outcomes }
  })
}

export async function listOrganizationInvitations(organizationId: string, actorId: string) {
  return workspaceDb.transaction(async tx => {
    const member = await requireActiveOrganizationMember(tx, organizationId, actorId)
    const rows = await tx.select({
      id: organizationInvitations.id, email: organizationInvitations.email,
      createdBy: organizationInvitations.createdBy, status: organizationInvitations.status,
      createdAt: organizationInvitations.createdAt, expiresAt: organizationInvitations.expiresAt,
    }).from(organizationInvitations).where(eq(organizationInvitations.organizationId, organizationId))
      .orderBy(asc(organizationInvitations.createdAt))
    return { invitations: rows.filter(row => member.role !== 'member' || row.createdBy === actorId) }
  })
}

export async function revokeOrganizationInvitation(organizationId: string, actorId: string, input: unknown) {
  const { invitationId } = z.object({ invitationId: invitationIdSchema }).strict().parse(input)
  return workspaceDb.transaction(async tx => {
    const member = await requireActiveOrganizationMember(tx, organizationId, actorId)
    const [invitation] = await tx.select().from(organizationInvitations)
      .where(and(eq(organizationInvitations.id, invitationId),
        eq(organizationInvitations.organizationId, organizationId))).for('update').limit(1)
    if (!invitation || (member.role === 'member' && invitation.createdBy !== actorId))
      throw new GovernanceError('access_denied')
    if (invitation.status !== 'pending') throw new GovernanceError('invalid_request')
    await tx.update(organizationInvitations).set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(organizationInvitations.id, invitation.id))
    await enqueueOrganizationAudit(tx, {
      organizationId, actorId, action: 'organization.invitation_revoked',
      targetId: invitation.id, metadata: { status: 'revoked' },
    })
    return { revoked: true }
  })
}

/** The signed-in verified account accepts only an invitation addressed to its current verified email. */
export async function acceptOrganizationInvitation(input: unknown, user: { id: string; email: string; name: string }) {
  const { token } = z.object({ token: tokenSchema }).strict().parse(input)
  const { rows: [canonical] } = await pool.query<{ email: string; name: string; emailVerified: boolean }>(
    'select email,name,"emailVerified" from "user" where id=$1', [user.id])
  if (!canonical?.emailVerified || canonical.email.toLowerCase() !== user.email.toLowerCase())
    throw new GovernanceError('access_denied')
  const tokenHash = hashToken(token)
  return workspaceDb.transaction(async tx => {
    // Read the routing ID without a row lock, then acquire the Organization lock first,
    // matching invitation writes and member removal. Recheck the invitation under lock.
    const [candidate] = await tx.select({ organizationId: organizationInvitations.organizationId })
      .from(organizationInvitations).where(eq(organizationInvitations.tokenHash, tokenHash)).limit(1)
    if (!candidate) throw new GovernanceError('invalid_request')
    const [organization] = await tx.select({ archivedAt: organizations.archivedAt }).from(organizations)
      .where(eq(organizations.id, candidate.organizationId)).for('update').limit(1)
    if (!organization || organization.archivedAt) throw new GovernanceError('invalid_request')
    const [invitation] = await tx.select().from(organizationInvitations)
      .where(and(eq(organizationInvitations.organizationId, candidate.organizationId),
        eq(organizationInvitations.tokenHash, tokenHash))).for('update').limit(1)
    if (!invitation || invitation.status !== 'pending' || invitation.expiresAt <= new Date()
      || invitation.email !== canonical.email.toLowerCase()) throw new GovernanceError('invalid_request')
    await assertOrganizationAccountWritable(tx, user.id)
    const [existing] = await tx.select({ status: organizationMembers.status })
      .from(organizationMembers).where(and(eq(organizationMembers.organizationId, candidate.organizationId),
        eq(organizationMembers.userId, user.id))).limit(1)
    // A suspended/removed user cannot be restored by an old invitation.
    if (existing) throw new GovernanceError('invalid_request')
    await tx.insert(organizationMembers).values({
      organizationId: candidate.organizationId, userId: user.id,
      name: canonical.name, email: canonical.email.toLowerCase(), role: 'member',
    })
    await tx.update(organizationInvitations).set({
      status: 'accepted', acceptedBy: user.id, updatedAt: new Date(),
    }).where(eq(organizationInvitations.id, invitation.id))
    await enqueueOrganizationAudit(tx, {
      organizationId: candidate.organizationId, actorId: user.id, action: 'organization.invitation_accepted',
      targetId: invitation.id, metadata: { role: 'member', status: 'accepted' },
    })
    return { organizationId: candidate.organizationId, joined: true, role: 'member' as const }
  })
}
