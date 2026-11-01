import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { accountDataExports } from '@/lib/db/schema'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers, workspaces } from '@/lib/db/workspace-schema'

/** How long an emailed download link works. */
export const EXPORT_LINK_TTL_MS = 24 * 60 * 60 * 1000
/** One export request per person per hour: each one sends an email and later reads all their data. */
export const EXPORT_COOLDOWN_MS = 60 * 60 * 1000
const TOKEN_PREFIX = 'mkx_'
const TOKEN_SHAPE = /^mkx_[A-Za-z0-9_-]{43}$/

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export type ExportReservation =
  | { ok: true; id: string; token: string; expiresAt: Date }
  | { ok: false; retryAfterMinutes: number }

/**
 * Reserves an export link unless the person asked for one within the last
 * hour. The check and the insert run in one transaction under a per-person
 * lock, so two clicks cannot both pass. Only the token's hash is stored.
 */
export async function reserveExport(userId: string, now = new Date()): Promise<ExportReservation> {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`account-export:${userId}`}, 0))`)
    const [latest] = await tx.select({ createdAt: accountDataExports.createdAt }).from(accountDataExports)
      .where(eq(accountDataExports.userId, userId)).orderBy(desc(accountDataExports.createdAt)).limit(1)
    const waited = latest ? now.getTime() - latest.createdAt.getTime() : Infinity
    if (waited < EXPORT_COOLDOWN_MS) return { ok: false as const, retryAfterMinutes: Math.max(1, Math.ceil((EXPORT_COOLDOWN_MS - waited) / 60_000)) }
    const id = crypto.randomUUID()
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const expiresAt = new Date(now.getTime() + EXPORT_LINK_TTL_MS)
    await tx.insert(accountDataExports).values({ id, userId, tokenHash: sha256(token), createdAt: now, expiresAt })
    return { ok: true as const, id, token, expiresAt }
  })
}

/** Gives the reservation back when its email could not be sent, so the person can ask again at once. */
export async function releaseExport(userId: string, id: string): Promise<void> {
  await db.delete(accountDataExports).where(and(eq(accountDataExports.id, id), eq(accountDataExports.userId, userId)))
}

/**
 * Whether `token` is a live export link of this person's. A link only ever
 * opens for the account that asked for it, and not after it expires; the file
 * can be downloaded again until then (a browser may retry a download).
 */
export async function claimExport(userId: string, token: string, now = new Date()): Promise<boolean> {
  if (!TOKEN_SHAPE.test(token)) return false
  const [row] = await db.update(accountDataExports).set({ downloadedAt: now })
    .where(and(eq(accountDataExports.tokenHash, sha256(token)), eq(accountDataExports.userId, userId), gt(accountDataExports.expiresAt, now)))
    .returning({ id: accountDataExports.id })
  return Boolean(row)
}

type Row = Record<string, unknown>
const rows = async (text: string, values: unknown[]) => (await pool.query<Row>(text, values)).rows

/**
 * Everything the person keeps in Mikka, as plain data. Each query names its
 * columns: no password hashes, OAuth or session tokens, API keys, secret
 * names or digests, saved-login secrets, or push tokens are ever selected.
 */
export async function buildAccountExport(userId: string, now = new Date()) {
  const u = [userId]
  const [profile] = await rows('select id, name, email, "emailVerified", image, "createdAt" from "user" where id = $1', u)
  const [
    signInMethods, preferences, timeZone, bots, agents, threads, threadMessages, botMessages,
    tasks, memory, artifacts, savedLogins, integrations, linear, telegram, repositories, devices, subscriptions,
  ] = await Promise.all([
    rows('select "providerId" as provider, "createdAt" from account where "userId" = $1 order by "createdAt"', u),
    rows('select "pushDecide", "pushReview", "pushFinished", "pushBriefing", "pushWhen", "memoryEnabled", "updatedAt" from user_preferences where "userId" = $1', u),
    rows('select "timeZone", "updatedAt" from user_time_zones where "userId" = $1', u),
    rows('select id, "workspaceId", name, color, shape, "createdAt" from bots where "ownerId" = $1 and kind = \'bot\' order by "createdAt"', u),
    rows('select id, name, harness, description, instructions, "createdAt" from agents where "userId" = $1 order by "createdAt"', u),
    rows('select id, "botId", "issueId", kind, status, prompt, "lastReply", "createdAt", "finishedAt" from agent_runs where "userId" = $1 order by "createdAt"', u),
    rows('select "runId", text, "createdAt" from run_messages where "userId" = $1 order by "createdAt"', u),
    rows('select "botId", position, message, "createdAt" from coordinator_messages where "userId" = $1 order by "botId", position', u),
    rows('select id, title, content, status, priority, scope, "createdAt", "updatedAt" from issues where "userId" = $1 order by "createdAt"', u),
    rows(`select kind, subject, value, confidence, state, "userEdited", "firstSeenAt", "lastSeenAt", "expiresAt" from user_facts where "userId" = $1 and state <> 'deleted' order by "firstSeenAt"`, u),
    rows('select id, title, kind, "latestVersion", "createdAt", "updatedAt" from artifacts where "userId" = $1 order by "createdAt"', u),
    rows('select origin, alt_origins as "altOrigins", username, auth_kind as "authKind", created_at as "createdAt", last_used_at as "lastUsedAt" from credentials where user_id = $1 and revoked_at is null order by created_at', u),
    rows('select toolkit, email, "isDefault", "updatedAt" from composio_accounts where "userId" = $1 order by toolkit', u),
    rows('select "organizationName", "createdAt", "revokedAt" from linear_connections where "userId" = $1', u),
    rows('select "telegramUserName", "linkedAt" from telegram_links where "userId" = $1', u),
    rows('select "remoteKey", "verifiedAt" from github_repository_installations where "userId" = $1 order by "remoteKey"', u),
    rows('select name, kind, platform, hostname, "lastSeenAt", "createdAt" from devices where "ownerId" = $1 order by "createdAt"', u),
    rows('select provider, "accountLabel", state, "createdAt" from byos_connections where "ownerId" = $1 and "removedAt" is null order by "createdAt"', u),
  ])
  const memberships = await workspaceDb.select({ name: workspaces.name, role: workspaceMembers.role, status: workspaceMembers.status, joinedAt: workspaceMembers.createdAt })
    .from(workspaceMembers).innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
  const messagesByRun = new Map<unknown, Row[]>()
  for (const message of threadMessages) messagesByRun.set(message.runId, [...messagesByRun.get(message.runId) ?? [], { text: message.text, createdAt: message.createdAt }])
  return {
    format: 'mikka-account-export', version: 1, exportedAt: now.toISOString(),
    profile: profile ?? null,
    signInMethods, preferences: preferences[0] ?? null, timeZone: timeZone[0] ?? null,
    workspaces: memberships, bots, agents,
    threads: threads.map(thread => ({ ...thread, messages: messagesByRun.get(thread.id) ?? [] })),
    botMessages, tasks, memory, artifacts, savedLogins,
    connections: { integrations, linear, telegram, repositories, devices, subscriptions },
  }
}

export type AccountExport = Awaited<ReturnType<typeof buildAccountExport>>