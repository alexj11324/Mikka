import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { executionIdentityForRun } from '@/lib/execution-identity'
import { agentRuns, agents, artifactShares, artifactVersions, artifacts, bots, issueMembers, issues, type ArtifactKind } from '@/lib/db/schema'
import { runAgentName, runBotName } from '@/lib/run-bot-name'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { artifactSubmittedEvent } from '@/lib/coordinator-events'
import { ARTIFACT_CONTENT_TYPES, ARTIFACT_EXTENSIONS, ARTIFACT_MAX_BYTES, cleanTitle, utf8Bytes } from '@/lib/artifacts/limits'
import { stripDiffMarkers } from '@/lib/artifacts/diff'
import type { ArtifactDetail, ArtifactListItem, ArtifactMedia, ArtifactSummary } from '@/lib/artifacts/types'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { artifactStorage, getArtifactObject, putArtifactObject } from '@/lib/artifacts/storage'
import { artifactChanged } from '@/lib/live/artifacts'
import { taskActivityChanged } from '@/lib/factory/activity-live'
import { artifactAccess, artifactReadAccess, artifactWorkspace, submissionWorkspace, type ArtifactReader } from './access'
import { taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import { enterprisePrincipal, type EnterprisePrincipal } from '@/lib/enterprise/principal'

// Artifacts in Neon (who, which version, share links) with their files in R2.
// Every read is scoped to the owner, or to a live share token.

export type { ArtifactDetail, ArtifactListItem, ArtifactSummary, ArtifactVersionInfo } from '@/lib/artifacts/types'

/** Who is handing an artifact over: the run's agent, or an agent signed in with OAuth. */
export interface ArtifactSubmitter {
  userId: string
  /** Verified host/session context for submissions without a run or task. */
  workspaceId?: string
  /** Verifier-supplied provenance, never accepted from the artifact body. */
  [enterprisePrincipal]?: EnterprisePrincipal
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
  // Revalidate even if a caller obtained its submitter before a share was withdrawn.
  const identity = submitter.runId ? await executionIdentityForRun(pool, submitter.runId, submitter.userId) : null
  if (identity && identity.outputOwner !== submitter.userId) throw new Error('executionIdentityUnavailable')
  const storage = artifactStorage()
  const hash = sha256(content)

  const workspaceId = await submissionWorkspace(submitter)
  return withTaskWorkspace({ id: submitter.userId, [enterprisePrincipal]: submitter[enterprisePrincipal] }, workspaceId, () => db.transaction(async tx => {
    await tx.execute(sql`select mikka_account_assert_writable(${submitter.userId})`)
    let artifactId = input.artifactId
    let version = 1
    if (artifactId) {
      const [existing] = await tx.select({ kind: artifacts.kind, latestVersion: artifacts.latestVersion }).from(artifacts)
        .where(and(eq(artifacts.id, artifactId), eq(artifacts.userId, submitter.userId), eq(artifacts.workspaceId, workspaceId))).for('update')
      if (!existing) return { error: 'not_found' as const, message: 'No artifact with that id for this person.' }
      if (existing.kind !== input.kind) return { error: 'kind_mismatch' as const, message: `That artifact is ${existing.kind}; send the same kind or start a new artifact.` }
      version = existing.latestVersion + 1
      await tx.update(artifacts).set({ title, latestVersion: version, updatedAt: new Date() }).where(eq(artifacts.id, artifactId))
    } else {
      artifactId = crypto.randomUUID()
      await tx.insert(artifacts).values({ id: artifactId, userId: submitter.userId, workspaceId, kind: input.kind, title, runId: submitter.runId, issueId: submitter.issueId })
    }
    const storageKey = `${submitter.userId}/${artifactId}/v${version}-${hash.slice(0, 12)}.${ARTIFACT_EXTENSIONS[input.kind]}`
    // The file goes up before the row commits, so a row never points at a missing object.
    if (storage === 'r2') await putArtifactObject(storageKey, content, ARTIFACT_CONTENT_TYPES[input.kind])
    await tx.insert(artifactVersions).values({
      id: crypto.randomUUID(), artifactId, version, storageKey, inlineContent: storage === 'inline' ? content : null,
      sha256: hash, size, authorName: submitter.authorName, executionIdentity: identity,
    })
    const submitted = { artifactId, version, title, kind: input.kind }
    // Version provenance must commit with its bytes and latest pointer. A
    // response interruption must not leave a visible version without its run.
    await recordCoordinatorEvent(tx, artifactSubmittedEvent(submitter, submitted))
    await artifactChanged(tx, submitter.userId, artifactId)
    if (submitter.runId) taskActivityChanged(tx, submitter.runId)
    return submitted
  }))
}

/** Titles and latest versions of the person's artifacts among `ids`, for cards in the chat. */
/** The Factory task whose acceptance report this artifact is (#1276), so a card can show the PR's state; null for any other artifact. */
const acceptanceTask = sql<string | null>`(SELECT f."taskId" FROM factory_acceptance_artifacts f WHERE f."artifactId"=${artifacts.id} LIMIT 1)`

export async function artifactSummaries(reader: ArtifactReader, ids: readonly string[]): Promise<Record<string, ArtifactSummary>> {
  if (!ids.length) return {}
  const rows = await db.select({ id: artifacts.id, kind: artifacts.kind, title: artifacts.title, latestVersion: artifacts.latestVersion, acceptanceTaskId: acceptanceTask })
    .from(artifacts).where(and(await artifactAccess(reader), inArray(artifacts.id, [...new Set(ids)])))
  return Object.fromEntries(rows.map(row => [row.id, row]))
}

async function detail(where: ReturnType<typeof and>): Promise<ArtifactDetail | null> {
  const [row] = await db.select({ id: artifacts.id, userId: artifacts.userId, workspaceId: artifacts.workspaceId, kind: artifacts.kind, title: artifacts.title, latestVersion: artifacts.latestVersion, runId: artifacts.runId, issueId: artifacts.issueId })
    .from(artifacts).where(where).limit(1)
  if (!row) return null
  const versions = await db.select({ version: artifactVersions.version, authorName: artifactVersions.authorName, createdAt: artifactVersions.createdAt })
    .from(artifactVersions).where(eq(artifactVersions.artifactId, row.id)).orderBy(asc(artifactVersions.version))
  // A version the run handed over is the run's Agent's (R-78), also when an older row stored the dispatching Bot's name.
  const agent = row.runId ? (await runAgents([row.runId])).get(row.runId) : undefined
  // Other authors are bots: shown with their own bloub, found by name, else by the run that handed the artifact over.
  const names = [...new Set(versions.map(version => version.authorName.toLowerCase()))]
  const named = names.length ? await db.select({ name: bots.name, color: bots.color, shape: bots.shape }).from(bots)
    .where(and(eq(bots.ownerId, row.userId), row.workspaceId ? eq(bots.workspaceId, row.workspaceId) : sql`false`, inArray(sql`lower(${bots.name})`, names))) : []
  const [runBot] = row.runId ? await db.select({ color: bots.color, shape: bots.shape }).from(agentRuns)
    .innerJoin(bots, eq(bots.id, agentRuns.botId)).where(eq(agentRuns.id, row.runId)).limit(1) : []
  const look = (name: string) => named.find(bot => bot.name.toLowerCase() === name.toLowerCase()) ?? runBot ?? null
  const { userId: _owner, workspaceId: _workspace, ...summary } = row
  return { ...summary, versions: versions.map(version => {
    if (agent?.wrote(version.authorName)) return { ...version, authorName: agent.name, createdAt: version.createdAt.toISOString(), authorColor: null, authorShape: null, authorHarness: agent.harness }
    const bot = look(version.authorName)
    return { ...version, createdAt: version.createdAt.toISOString(), authorColor: bot?.color ?? null, authorShape: bot?.shape ?? null, authorHarness: null }
  }) }
}

/** One of the person's artifacts with every version, oldest first. */
export async function readArtifact(reader: ArtifactReader, artifactId: string): Promise<ArtifactDetail | null> {
  const { userId } = taskReaderScope(reader)
  const found = await detail(and(eq(artifacts.id, artifactId), await artifactAccess(reader)))
  if (!found) return null
  const [live] = await db.select({ id: artifactShares.id }).from(artifactShares)
    .where(and(eq(artifactShares.artifactId, artifactId), isNull(artifactShares.revokedAt))).limit(1)
  // The bot whose run made it, so its window sits beside that bot's chat (as on the Artifact page); only the person's own run counts.
  const [run] = found.runId ? await db.select({ botId: agentRuns.botId }).from(agentRuns)
    .where(and(eq(agentRuns.id, found.runId), eq(agentRuns.userId, userId))).limit(1) : []
  return { ...found, botId: run?.botId ?? null, shared: Boolean(live), ...await acceptanceReport(artifactId) }
}

/** A PR report's task id (「ALEX-84」) for its window title; null for any other artifact or a task the person no longer sees. */
export async function reportIssueKey(reader: ArtifactReader, found: ArtifactDetail): Promise<string | null> {
  if (!found.acceptanceTaskId || !found.issueId) return null
  const [keyed] = await withIssueKeys(reader, [{ id: found.id, kind: found.kind, title: found.title, latestVersion: found.latestVersion,
    runId: found.runId, issueId: found.issueId, botId: null, authorName: null, updatedAt: new Date() }])
  return keyed?.issueKey ?? null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A Factory acceptance report's recordings (#1276): the capture ids its
 * Markdown links to as videos, so the reader plays them in place. The index
 * row belongs to the artifact the caller already read as its owner; captures
 * are still served only through the owner-checked capture route.
 */
async function acceptanceReport(artifactId: string): Promise<Pick<ArtifactDetail, 'media' | 'acceptanceTaskId'>> {
  const { rows: [row] } = await pool.query<{ taskId: string; media: unknown }>('SELECT "taskId",media FROM factory_acceptance_artifacts WHERE "artifactId"=$1 LIMIT 1', [artifactId])
  const media = (Array.isArray(row?.media) ? row.media : []).flatMap((item): ArtifactMedia[] => {
    const entry = item as { captureId?: unknown; kind?: unknown; title?: unknown }
    return typeof entry.captureId === 'string' && UUID.test(entry.captureId) && (entry.kind === 'video' || entry.kind === 'image')
      ? [{ captureId: entry.captureId, kind: entry.kind, title: typeof entry.title === 'string' ? entry.title.slice(0, 200) : '' }] : []
  }).slice(0, 40)
  return { media, acceptanceTaskId: row?.taskId ?? null }
}

const LIST_LIMIT = 200

const listColumns = { id: artifacts.id, kind: artifacts.kind, title: artifacts.title, latestVersion: artifacts.latestVersion, acceptanceTaskId: acceptanceTask, runId: artifacts.runId, issueId: artifacts.issueId, botId: agentRuns.botId, updatedAt: artifacts.updatedAt, authorName: artifactVersions.authorName }
/** The run that made it, for its bot (a run is the person's own, as the artifact is). */
const madeBy = and(eq(agentRuns.id, artifacts.runId), eq(agentRuns.userId, artifacts.userId))
const latestVersion = and(eq(artifactVersions.artifactId, artifacts.id), eq(artifactVersions.version, artifacts.latestVersion))
/** The issue number as stored in its document; null when it has none. */
const issueNumber = sql<number | null>`(coalesce(${issues.content}->'attrs'->'mikka', ${issues.content}->'attrs'->'orvilo')->>'number')::int`

/** Rows with their task key: only for tasks the person can still see. */
async function withIssueKeys(reader: ArtifactReader, rows: (Omit<ArtifactListItem, 'issueKey' | 'updatedAt'> & { updatedAt: Date })[], access?: Awaited<ReturnType<typeof artifactReadAccess>>): Promise<ArtifactListItem[]> {
  const { userId } = taskReaderScope(reader)
  const issueIds = [...new Set(rows.flatMap(row => row.issueId ? [row.issueId] : []))]
  const current = issueIds.length ? access ?? await artifactReadAccess(reader) : null
  // Reuse this operation's fresh reader gate and the authorized rows' issued
  // identifiers; Team grouping and names cannot change a task's identity.
  const tasks = current ? await db.selectDistinct({ id: issues.id, ownerId: issues.userId, scope: issues.scope, number: issueNumber,
    issuedIdentifier: issues.issuedIdentifier })
    .from(issues).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
    .where(and(inArray(issues.id, issueIds), current.taskPredicate)) : []
  const identifiers = await taskIdentifiers(tasks, db)
  const numbers = new Map(tasks.map(task => [task.id, task.number]))
  return rows.map(({ updatedAt, ...row }) => {
    const number = row.issueId ? numbers.get(row.issueId) ?? null : null
    const issueKey = row.issueId && numbers.has(row.issueId) ? identifiers.get(row.issueId) ?? (number === null ? null : `#${number}`) : null
    return { ...row, issueKey, updatedAt: updatedAt.toISOString() }
  })
}

/** Each run's Agent: its name and harness, and whether a stored author name is that run's (the Agent, or the Bot that dispatched it). */
async function runAgents(runIds: string[]) {
  const rows = runIds.length ? await db.select({ id: agentRuns.id, harness: agents.harness, name: runAgentName, botName: runBotName })
    .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).where(inArray(agentRuns.id, [...new Set(runIds)])) : []
  return new Map(rows.map(row => [row.id, { name: row.name, harness: row.harness, wrote: (author: string | null) => !!author && [row.name, row.botName].some(name => name?.toLowerCase() === author.toLowerCase()) }]))
}

/** A run's artifacts in a list name the run's Agent as their latest author. */
async function withAgentAuthors<T extends { runId: string | null; authorName: string | null }>(rows: T[]): Promise<T[]> {
  const agents = await runAgents(rows.flatMap(row => row.runId ? [row.runId] : []))
  return rows.map(row => {
    const agent = row.runId ? agents.get(row.runId) : undefined
    return agent?.wrote(row.authorName) ? { ...row, authorName: agent.name } : row
  })
}

/** The person's artifacts, last changed first, each with its latest author and the task it was made for. */
export async function listArtifacts(reader: ArtifactReader): Promise<ArtifactListItem[]> {
  const access = await artifactReadAccess(reader)
  const rows = await db.select(listColumns).from(artifacts).leftJoin(artifactVersions, latestVersion).leftJoin(agentRuns, madeBy)
    .where(access.artifactPredicate).orderBy(desc(artifacts.updatedAt)).limit(LIST_LIMIT)
  return withIssueKeys(reader, await withAgentAuthors(rows), access)
}

/** What one of the person's runs handed over, last changed first. */
export async function listRunArtifacts(reader: ArtifactReader, runId: string): Promise<ArtifactListItem[]> {
  const access = await artifactReadAccess(reader)
  const rows = await db.select(listColumns).from(artifacts).leftJoin(artifactVersions, latestVersion).leftJoin(agentRuns, madeBy)
    .where(and(access.artifactPredicate, eq(artifacts.runId, runId))).orderBy(desc(artifacts.updatedAt)).limit(LIST_LIMIT)
  return withIssueKeys(reader, await withAgentAuthors(rows), access)
}

/** The file of one version, or null when the artifact or version is not there. */
async function versionContent(artifactId: string, version: number): Promise<string | null> {
  const [row] = await db.select({ storageKey: artifactVersions.storageKey, inlineContent: artifactVersions.inlineContent })
    .from(artifactVersions).where(and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.version, version))).limit(1)
  if (!row) return null
  return row.inlineContent ?? await getArtifactObject(row.storageKey)
}

/** The person's artifact file at `version`. */
export async function readArtifactContent(reader: ArtifactReader, artifactId: string, version: number): Promise<{ kind: ArtifactKind; title: string; content: string } | null> {
  const [row] = await db.select({ kind: artifacts.kind, title: artifacts.title,
    storageKey: artifactVersions.storageKey, inlineContent: artifactVersions.inlineContent }).from(artifacts)
    .innerJoin(artifactVersions, and(eq(artifactVersions.artifactId, artifacts.id), eq(artifactVersions.version, version)))
    .where(and(eq(artifacts.id, artifactId), await artifactAccess(reader))).limit(1)
  if (!row) return null
  return { kind: row.kind, title: row.title, content: row.inlineContent ?? await getArtifactObject(row.storageKey) }
}

// --- Share links ----------------------------------------------------------

const SHARE_PREFIX = 'mks_'

/** A new link anyone can open; returns the token once. */
export async function createShare(reader: ArtifactReader, artifactId: string): Promise<{ token: string } | null> {
  const workspaceId = await artifactWorkspace(reader, artifactId)
  if (!workspaceId) return null
  const { userId } = taskReaderScope(reader)
  return withTaskWorkspace(reader, workspaceId, async () => {
    const token = `${SHARE_PREFIX}${randomBytes(24).toString('base64url')}`
    await db.insert(artifactShares).values({ id: crypto.randomUUID(), artifactId, tokenHash: sha256(token), createdBy: userId })
    await artifactChanged(db, userId, artifactId)
    return { token }
  })
}

/** Ends every live link to the artifact. */
export async function revokeShares(reader: ArtifactReader, artifactId: string): Promise<number> {
  const workspaceId = await artifactWorkspace(reader, artifactId)
  if (!workspaceId) return 0
  const { userId } = taskReaderScope(reader)
  return withTaskWorkspace(reader, workspaceId, async () => {
  const revoked = await db.update(artifactShares).set({ revokedAt: new Date() })
    .where(and(eq(artifactShares.artifactId, artifactId), isNull(artifactShares.revokedAt), sql`exists (select 1 from ${artifacts} where ${artifacts.id} = ${artifactShares.artifactId} and ${artifacts.userId} = ${userId})`))
    .returning({ id: artifactShares.id })
  if (revoked.length) await artifactChanged(db, userId, artifactId)
  return revoked.length
  })
}

async function sharedArtifactAccess(token: string) {
  if (!token.startsWith(SHARE_PREFIX)) return null
  const [share] = await db.select({ artifactId: artifactShares.artifactId, createdBy: artifactShares.createdBy }).from(artifactShares)
    .where(and(eq(artifactShares.tokenHash, sha256(token)), isNull(artifactShares.revokedAt))).limit(1)
  if (!share) return null
  // A removed/suspended issuer cannot leave an anonymous back door into a tenant.
  return and(eq(artifacts.id, share.artifactId), await artifactAccess(share.createdBy))
}

/** Markdown is rendered inline. An HTML share's iframe reads its own body. */
export async function sharedArtifact(token: string): Promise<(ArtifactDetail & { content: string | null }) | null> {
  const access = await sharedArtifactAccess(token)
  if (!access) return null
  const found = await detail(access)
  if (!found) return null
  if (found.kind === 'html') return found.versions.some(row => row.version === found.latestVersion) ? { ...found, content: null } : null
  const content = await versionContent(found.id, found.latestVersion)
  return content === null ? null : { ...found, content }
}

/** The sandboxed frame needs the latest HTML body without author/version history. */
export async function sharedArtifactFrame(token: string): Promise<string | null> {
  const access = await sharedArtifactAccess(token)
  if (!access) return null
  const [row] = await db.select({ storageKey: artifactVersions.storageKey, inlineContent: artifactVersions.inlineContent })
    .from(artifacts).innerJoin(artifactVersions, and(eq(artifactVersions.artifactId, artifacts.id), eq(artifactVersions.version, artifacts.latestVersion)))
    .where(and(access, eq(artifacts.kind, 'html'))).limit(1)
  return row ? row.inlineContent ?? await getArtifactObject(row.storageKey) : null
}
