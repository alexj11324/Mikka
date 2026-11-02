import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { daemonTestMode, normalizeRepository, remoteKey, repositoryBindingMatches } from '@mikka/protocol/repository'
import { db } from '@/lib/db'
import { deviceRepos, repositorySettings } from '@/lib/db/schema'

/** A scheduling record, not an allow-list or a path on the person's machine. */
export async function ensureDeviceRepository(userId: string, deviceId: string, input: string) {
  const options = { allowFile: daemonTestMode(process.env) }
  const repository = normalizeRepository(input, options)
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`device-repo:${deviceId}:${repository.key}`},0))`)
    const rows = await tx.select().from(deviceRepos).where(and(eq(deviceRepos.deviceId, deviceId), eq(deviceRepos.userId, userId)))
    const existing = rows.find(row => row.repoPath === repository.key)
      ?? rows.filter(row => repository.key.startsWith('v2/github.com/') && row.repoPath.startsWith('/') && repositoryBindingMatches(repository.key, row.remoteUrl, options))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0]
    if (existing) {
      if (!repositoryBindingMatches(repository.key, existing.remoteUrl, options)) throw new Error('Repository identity mismatch')
      if (existing.repoPath === repository.key) return existing
      // A legacy registration may name a user checkout. Reuse its FK while
      // replacing that path with the logical key; historical branch values stay.
      // Preserve the original clone URL: an existing queued assignment keeps
      // its endpoint even when another request supplies an equivalent alias.
      const [updated] = await tx.update(deviceRepos).set({ repoPath: repository.key })
        .where(and(eq(deviceRepos.id, existing.id), eq(deviceRepos.userId, userId))).returning()
      if (!updated) throw new Error('Repository unavailable')
      return updated
    }
    const [row] = await tx.insert(deviceRepos).values({
      id: crypto.randomUUID(), userId, deviceId, repoPath: repository.key,
      remoteUrl: repository.remoteUrl, baseBranch: null, verifyCommand: null,
    }).onConflictDoNothing({ target: [deviceRepos.deviceId, deviceRepos.repoPath] }).returning()
    if (!row) throw new Error('Repository unavailable')
    return row
  })
}

export async function readRepositorySettings(userId: string, remoteUrl: string) {
  let key: string
  try { key = remoteKey(remoteUrl) } catch { return null }
  const [settings] = await db.select().from(repositorySettings)
    .where(and(eq(repositorySettings.userId, userId), eq(repositorySettings.remoteKey, key))).limit(1)
  return settings ?? null
}

export async function saveRepositoryVerifyCommand(userId: string, remoteUrl: string, verifyCommand: string | null) {
  const key = remoteKey(remoteUrl)
  const [settings] = await db.insert(repositorySettings).values({ userId, remoteKey: key, verifyCommand })
    .onConflictDoUpdate({ target: [repositorySettings.userId, repositorySettings.remoteKey], set: { verifyCommand, updatedAt: new Date() } }).returning()
  return settings
}
