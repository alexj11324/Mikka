import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { after } from 'next/server'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentRuns, artifactShares, artifactVersions, artifacts, bots, issues, type ArtifactKind } from '@/lib/db/schema'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { artifactSubmittedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { ARTIFACT_CONTENT_TYPES, ARTIFACT_EXTENSIONS, ARTIFACT_MAX_BYTES, cleanTitle, utf8Bytes } from '@/lib/artifacts/limits'
import { stripDiffMarkers } from '@/lib/artifacts/diff'
import type { ArtifactDetail, ArtifactListItem, ArtifactSummary } from '@/lib/artifacts/types'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { artifactStorage, getArtifactObject, putArtifactObject } from '@/lib/artifacts/storage'

// Artifacts in Neon (who, which version, share links) with their files in R2.
// Every read is scoped to the owner, or to a live share token.

export type { ArtifactDetail, ArtifactListItem, ArtifactSummary, ArtifactVersionInfo } from '@/lib/artifacts/types'

/** Who is handing an artifact over: the run's agent, or an agent signed in with OAuth. */
export interface ArtifactSubmitter {
  userId: string
  /** The bot whose run made it, so the card shows in that bot's chat; null for the Coordinator. */
  botId?: string | null
  runId: string | null
  issueId: string | null
  authorName: string
}

export type SubmitResult =
  | { artifactId: string; version: number; title: string; kind: ArtifactKind }
  | { error: 'too_large' | 'empty' | 'not_found' | 'kind_mismatch'; message: string }

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Stores a new artifact, or a new version of `artifactId`, and tells the
 * person's Coordinator so the card shows in the chat.
 */
export async function submitArtifact(submitter: ArtifactSubmitter, input: { title: string; kind: ArtifactKind; content: string; artifactId?: string }): Promise<SubmitResult> {
  const content = stripDiffMarkers(input.content)
  const title = cleanTitle(input.title)
  if (!content.trim() || !title) return { error: 'empty', message: 'Title and content must not be empty.' }
  const size = utf8Bytes(content)
  if (size > ARTIFACT_MAX_BYTES[input.kind]) return { error: 'too_large', message: `At most ${ARTIFACT_MAX_BYTES[input.kind]} bytes for ${input.kind}.` }
  const storage = artifactStorage()
  const hash = sha256(content)

  const result = await db.transaction(async tx => {
    let artifactId = input.artifactId
    let version = 1
    if (artifactId) {
      const [existing] = await tx.select({ kind: artifacts.kind, latestVersion: artifacts.latestVersion }).from(artifacts)
        .where(and(eq(artifacts.id, artifactId), eq(artifacts.userId, submitter.userId))).for('update')
      if (!existing) return { error: 'not_found' as const, message: 'No artifact with that id for this person.' }
      if (existing.kind !== input.kind) return { error: 'kind_mismatch' as const, message: `That artifact is ${existing.kind}; send the same kind or start a new artifact.` }
      version = existing.latestVersion + 1
      await tx.update(artifacts).set({ title, latestVersion: version, updatedAt: new Date() }).where(eq(artifacts.id, artifactId))
    } else {
      artifactId = crypto.randomUUID()
      await tx.insert(artifacts).values({ id: artifactId, userId: submitter.userId, kind: input.kind, title, runId: submitter.runId, issueId: submitter.issueId })
    }
    const storageKey = `${submitter.userId}/${artifactId}/v${version}-${hash.slice(0, 12)}.${ARTIFACT_EXTENSIONS[input.kind]}`
    // The file goes up before the row commits, so a row never points at a missing object.
    if (storage === 'r2') await putArtifactObject(storageKey, content, ARTIFACT_CONTENT_TYPES[input.kind])
    await tx.insert(artifactVersions).values({
      id: crypto.randomUUID(), artifactId, version, storageKey, inlineContent: storage === 'inline' ? content : null,
      sha256: hash, size, authorName: submitter.authorName,
    })
    return { artifactId, version, title, kind: input.kind }
  })
  if ('error' in result) return result
  await recordCoordinatorEvent(db, artifactSubmittedEvent(submitter, result))
  after(() => wakeCoordinator(submitter.userId))
  return result
}

/** Titles and latest versions of the person's artifacts among `ids`, for cards in the chat. */
export async function artifactSummaries(userId: string, ids: readonly string[]): Promise<Record<string, ArtifactSummary>> {
  if (!ids.length) return {}
  const rows = await db.select({ id: artifacts.id, kind: artifacts.kind, title: artifacts.title, latestVersion: artifacts.latestVersion })
    .from(artifacts).where(and(eq(artifacts.userId, userId), inArray(artifacts.id, [...new Set(ids)])))
  return Object.fromEntries(rows.map(row => [row.id, row]))
}

async function detail(where: ReturnType<typeof and>): Promise<ArtifactDetail | null> {
  const [row] = await db.select({ id: artifacts.id, userId: artifacts.userId, kind: artifacts.kind, title: artifacts.title, latestVersion: artifacts.latestVersion, runId: artifacts.runId, issueId: artifacts.issueId })
    .from(artifacts).where(where).limit(1)
  if (!row) return null
  const versions = await db.select({ version: artifactVersions.version, authorName: artifactVersions.authorName, createdAt: artifactVersions.createdAt })
    .from(artifactVersions).where(eq(artifactVersions.artifactId, row.id)).orderBy(asc(artifactVersions.version))
  // Authors are bots: shown with their own bloub, found by name, else by the run that handed the artifact over.
  const names = [...new Set(versions.map(version => version.authorName.toLowerCase()))]
  const named = names.length ? await db.select({ name: bots.name, color: bots.color, shape: bots.shape }).from(bots)
    .where(and(eq(bots.ownerId, row.userId), inArray(sql`lower(${bots.name})`, names))) : []
  const [runBot] = row.runId ? await db.select({ color: bots.color, shape: bots.shape }).from(agentRuns)
    .innerJoin(bots, eq(bots.id, agentRuns.botId)).where(eq(agentRuns.id, row.runId)).limit(1) : []
  const look = (name: string) => named.find(bot => bot.name.toLowerCase() === name.toLowerCase()) ?? runBot ?? null
  const { userId: _owner, ...summary } = row
  return { ...summary, versions: versions.map(version => {
    const bot = look(version.authorName)
    return { ...version, createdAt: version.createdAt.toISOString(), authorColor: bot?.color ?? null, authorShape: bot?.shape ?? null }
  }) }
}

/** One of the person's artifacts with every version, oldest first. */
export async function readArtifact(userId: string, artifactId: string): Promise<ArtifactDetail | null> {
  const found = await detail(and(eq(artifacts.id, artifactId), eq(artifacts.userId, userId)))
  if (!found) return null
  const [live] = await db.select({ id: artifactShares.id }).from(artifactShares)
    .where(and(eq(artifactShares.artifactId, artifactId), isNull(artifactShares.revokedAt))).limit(1)
  return { ...found, shared: Boolean(live) }
}

const LIST_LIMIT = 200

/** The person's artifacts, last changed first, each with its latest author and the task it was made for. */
export async function listArtifacts(userId: string): Promise<ArtifactListItem[]> {
  const rows = await db.select({ id: artifacts.id, kind: artifacts.kind, title: artifacts.title, latestVersion: artifacts.latestVersion, runId: artifacts.runId, issueId: artifacts.issueId, updatedAt: artifacts.updatedAt, authorName: artifactVersions.authorName })
    .from(artifacts)
    .leftJoin(artifactVersions, and(eq(artifactVersions.artifactId, artifacts.id), eq(artifactVersions.version, artifacts.latestVersion)))
    .where(eq(artifacts.userId, userId)).orderBy(desc(artifacts.updatedAt)).limit(LIST_LIMIT)
  const issueIds = [...new Set(rows.flatMap(row => row.issueId ? [row.issueId] : []))]
  const tasks = issueIds.length ? await db.select({ id: issues.id, ownerId: issues.userId, scope: issues.scope, content: issues.content }).from(issues).where(inArray(issues.id, issueIds)) : []
  const numbers = new Map(tasks.map(task => [task.id, readIssueMetadata(task.content).number ?? null]))
  const identifiers = await taskIdentifiers(tasks.map(task => ({ id: task.id, ownerId: task.ownerId, scope: task.scope, number: numbers.get(task.id) ?? null })))
  return rows.map(({ updatedAt, ...row }) => {
    const number = row.issueId ? numbers.get(row.issueId) ?? null : null
    const issueKey = row.issueId ? identifiers.get(row.issueId) ?? (number === null ? null : `#${number}`) : null
    return { ...row, issueKey, updatedAt: updatedAt.toISOString() }
  })
}

/** The file of one version, or null when the artifact or version is not there. */
async function versionContent(artifactId: string, version: number): Promise<string | null> {
  const [row] = await db.select({ storageKey: artifactVersions.storageKey, inlineContent: artifactVersions.inlineContent })
    .from(artifactVersions).where(and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.version, version))).limit(1)
  if (!row) return null
  return row.inlineContent ?? await getArtifactObject(row.storageKey)
}

/** The person's artifact file at `version`. */
export async function readArtifactContent(userId: string, artifactId: string, version: number): Promise<{ kind: ArtifactKind; title: string; content: string } | null> {
  const [row] = await db.select({ kind: artifacts.kind, title: artifacts.title }).from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.userId, userId))).limit(1)
  if (!row) return null
  const content = await versionContent(artifactId, version)
  return content === null ? null : { ...row, content }
}

// --- Share links ----------------------------------------------------------

const SHARE_PREFIX = 'mks_'

/** A new link anyone can open; returns the token once. */
export async function createShare(userId: string, artifactId: string): Promise<{ token: string } | null> {
  const [row] = await db.select({ id: artifacts.id }).from(artifacts).where(and(eq(artifacts.id, artifactId), eq(artifacts.userId, userId))).limit(1)
  if (!row) return null
  const token = `${SHARE_PREFIX}${randomBytes(24).toString('base64url')}`
  await db.insert(artifactShares).values({ id: crypto.randomUUID(), artifactId, tokenHash: sha256(token), createdBy: userId })
  return { token }
}

/** Ends every live link to the artifact. */
export async function revokeShares(userId: string, artifactId: string): Promise<number> {
  const revoked = await db.update(artifactShares).set({ revokedAt: new Date() })
    .where(and(eq(artifactShares.artifactId, artifactId), isNull(artifactShares.revokedAt), sql`exists (select 1 from ${artifacts} where ${artifacts.id} = ${artifactShares.artifactId} and ${artifacts.userId} = ${userId})`))
    .returning({ id: artifactShares.id })
  return revoked.length
}

/** The artifact a live share token opens, at its latest version. */
export async function sharedArtifact(token: string): Promise<(ArtifactDetail & { content: string }) | null> {
  if (!token.startsWith(SHARE_PREFIX)) return null
  const [share] = await db.select({ artifactId: artifactShares.artifactId }).from(artifactShares)
    .where(and(eq(artifactShares.tokenHash, sha256(token)), isNull(artifactShares.revokedAt))).limit(1)
  if (!share) return null
  const found = await detail(and(eq(artifacts.id, share.artifactId)))
  if (!found) return null
  const content = await versionContent(found.id, found.latestVersion)
  return content === null ? null : { ...found, content }
}
