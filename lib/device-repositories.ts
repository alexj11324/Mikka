import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { daemonTestMode, normalizeRepository, remoteKey } from '@mikka/protocol/repository'
import { db } from '@/lib/db'
import { deviceRepos, repositorySettings } from '@/lib/db/schema'

/** A scheduling record, not an allow-list or a path on the person's machine. */
export async function ensureDeviceRepository(userId: string, deviceId: string, input: string) {
  const repository = normalizeRepository(input, { allowFile: daemonTestMode(process.env) })
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`device-repo:${deviceId}:${repository.key}`},0))`)
    const rows = await tx.select().from(deviceRepos).where(and(eq(deviceRepos.deviceId, deviceId), eq(deviceRepos.userId, userId)))
    const existing = rows.find(row => row.repoPath === repository.key)
      ?? rows.filter(row => row.remoteUrl && remoteKey(row.remoteUrl) === repository.key)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0]
    if (existing) {
      // A legacy registration may name a user checkout. Reuse its FK while
      // replacing that path with the logical key; historical branch values stay.
      const [updated] = await tx.update(deviceRepos).set({ repoPath: repository.key, remoteUrl: repository.remoteUrl })
        .where(and(eq(deviceRepos.id, existing.id), eq(deviceRepos.userId, userId))).returning()
      if (!updated) throw new Error('Repository unavailable')
      return updated
    }
    const [row] = await tx.insert(deviceRepos).values({
      id: crypto.randomUUID(), userId, deviceId, repoPath: repository.key,
      remoteUrl: repository.remoteUrl, baseBranch: null, verifyCommand: null,
    }).onConflictDoUpdate({ target: [deviceRepos.deviceId, deviceRepos.repoPath], set: { remoteUrl: repository.remoteUrl }, setWhere: eq(deviceRepos.userId, userId) }).returning()
    if (!row) throw new Error('Repository unavailable')
    return row
  })
}

export async function readRepositorySettings(userId: string, remoteUrl: string) {
  const [settings] = await db.select().from(repositorySettings)
    .where(and(eq(repositorySettings.userId, userId), eq(repositorySettings.remoteKey, remoteKey(remoteUrl)))).limit(1)
  return settings ?? null
}
