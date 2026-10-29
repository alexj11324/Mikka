import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { createLinearOAuthRevocationProcessor } from './oauth-revocation-core'
import { linearConnections, linearTeamSyncs } from '@/lib/db/schema'

const disableOwners = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], userIds: string[]) => {
  if (userIds.length) {
    await tx.update(linearTeamSyncs).set({ active: false, updatedAt: new Date() })
      .where(and(inArray(linearTeamSyncs.ownerId, userIds), eq(linearTeamSyncs.active, true)))
  }
}

export const processLinearOAuthRevocation = createLinearOAuthRevocationProcessor({
  revokeAuthorization: async (organizationId, linearUserId) => db.transaction(async tx => {
    const now = new Date()
    const revoked = await tx.update(linearConnections).set({ revokedAt: sql`coalesce(${linearConnections.revokedAt}, ${now})`, updatedAt: now })
      .where(and(
        eq(linearConnections.organizationId, organizationId),
        eq(linearConnections.linearUserId, linearUserId),
      ))
      .returning({ userId: linearConnections.userId })
    await disableOwners(tx, revoked.map(row => row.userId))
  }),
  revokeOrganization: async organizationId => db.transaction(async tx => {
    const now = new Date()
    const revoked = await tx.update(linearConnections).set({ revokedAt: sql`coalesce(${linearConnections.revokedAt}, ${now})`, updatedAt: now })
      .where(eq(linearConnections.organizationId, organizationId))
      .returning({ userId: linearConnections.userId })
    await disableOwners(tx, revoked.map(row => row.userId))
  }),
})
