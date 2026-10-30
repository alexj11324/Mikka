import 'server-only'
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { personalAccessTokens } from '@/lib/db/token-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { checkExpiry, createTokenInput, generatePersonalAccessToken, hashPersonalAccessToken, PAT_ACTIVE_LIMIT, PAT_SHAPE, revokeTokenInput } from './format'

/** A token as listed. Never carries the hash or the plaintext. */
export interface PersonalAccessTokenView {
  id: string
  name: string
  /** Last 4 characters; show as mkp_…abcd. */
  hint: string
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  expired: boolean
}

export interface CreatedPersonalAccessToken extends PersonalAccessTokenView {
  /** The only time the plaintext leaves the server. Not retrievable later. */
  token: string
}

type Row = typeof personalAccessTokens.$inferSelect

const view = (row: Row, now: Date): PersonalAccessTokenView => ({
  id: row.id, name: row.name, hint: row.hint,
  createdAt: row.createdAt.toISOString(),
  expiresAt: row.expiresAt?.toISOString() ?? null,
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  expired: !!row.expiresAt && row.expiresAt.getTime() <= now.getTime(),
})

/** SQLSTATE (5 chars) on the error or its cause chain; app codes like 'tokenNotFound' are ignored. */
const pgCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : pgCode((error as { cause?: unknown }).cause)
}
/** Generic stand-in for a DB failure: no cause, params (tokenHash) or query text. */
export class TokenStoreError extends Error {
  constructor(readonly pgCode?: string) { super(`personal access token store query failed${pgCode ? ` (${pgCode})` : ''}`); this.name = 'TokenStoreError' }
}
/** DrizzleQueryError puts the bound params (incl. tokenHash) in its message; replace it before it can reach a log. */
async function guardTokenDb<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() } catch (error) {
    if (error instanceof WorkspaceError || error instanceof TokenStoreError) throw error
    if ((error as Error)?.name !== 'DrizzleQueryError' && pgCode(error) === undefined) throw error
    throw new TokenStoreError(pgCode(error))
  }
}

async function requireMember(userId: string, workspaceId: string) {
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, userId))
}

/**
 * Creates a token for the person in this workspace. Only its sha256 is stored;
 * the plaintext is returned here once. Errors: validationGeneric (bad name or
 * expiry), tokenLimitReached (PAT_ACTIVE_LIMIT active tokens), workspaceAccessDenied.
 */
export async function createPersonalAccessToken(userId: string, workspaceId: string, input: unknown, now = new Date()): Promise<CreatedPersonalAccessToken> {
  const { name, expiresAt } = createTokenInput.parse(input)
  let expiry: Date | null
  try { expiry = checkExpiry(expiresAt, now) } catch { throw new WorkspaceError('validationGeneric') }
  await requireMember(userId, workspaceId)
  const { token, tokenHash, hint } = generatePersonalAccessToken()
  const row = await guardTokenDb(async () => {
    // A plain count: concurrent creates can briefly pass the soft cap by a few tokens (no lock).
    const [{ active }] = await db.select({ active: sql<number>`count(*)::int` }).from(personalAccessTokens)
      .where(and(eq(personalAccessTokens.userId, userId), eq(personalAccessTokens.workspaceId, workspaceId), isNull(personalAccessTokens.revokedAt),
        // Expired tokens no longer hold a slot toward PAT_ACTIVE_LIMIT.
        or(isNull(personalAccessTokens.expiresAt), gt(personalAccessTokens.expiresAt, now))))
    if (active >= PAT_ACTIVE_LIMIT) throw new WorkspaceError('tokenLimitReached')
    const [saved] = await db.insert(personalAccessTokens).values({ id: crypto.randomUUID(), userId, workspaceId, name, tokenHash, hint, createdAt: now, expiresAt: expiry }).returning()
    // TODO(audit): after PR #432 merges, record 'token.created' (target: the token id, label: its name) with recordAudit
    // in one transaction with this insert. Rule (#432 lib/audit/record.ts): MIKKA-DB token writes never use recordAuditSafe.
    return saved
  })
  return { ...view(row, now), token }
}

/** The person's unrevoked tokens in this workspace, newest first (expired ones included, flagged). */
export async function listPersonalAccessTokens(userId: string, workspaceId: string, now = new Date()): Promise<PersonalAccessTokenView[]> {
  await requireMember(userId, workspaceId)
  const rows = await guardTokenDb(() => db.select().from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.userId, userId), eq(personalAccessTokens.workspaceId, workspaceId), isNull(personalAccessTokens.revokedAt)))
    .orderBy(desc(personalAccessTokens.createdAt), desc(personalAccessTokens.id)))
  return rows.map(row => view(row, now))
}

/** Revokes one of the person's own tokens. Someone else's, unknown or already revoked → tokenNotFound. */
export async function revokePersonalAccessToken(userId: string, workspaceId: string, input: unknown, now = new Date()): Promise<{ id: string }> {
  const { id } = revokeTokenInput.parse(input)
  await requireMember(userId, workspaceId)
  return guardTokenDb(() => db.transaction(async tx => {
    const [revoked] = await tx.update(personalAccessTokens).set({ revokedAt: now })
      .where(and(eq(personalAccessTokens.id, id), eq(personalAccessTokens.userId, userId), eq(personalAccessTokens.workspaceId, workspaceId), isNull(personalAccessTokens.revokedAt)))
      .returning({ id: personalAccessTokens.id, name: personalAccessTokens.name })
    if (!revoked) throw new WorkspaceError('tokenNotFound')
    // TODO(audit): after PR #432 merges, recordAudit(tx, { action: 'token.revoked', target: { type: 'token', id, label: revoked.name }, … })
    // inside this transaction (MIKKA-DB token write rule from #432).
    return { id: revoked.id }
  }))
}

export interface TokenPrincipal { tokenId: string; userId: string; workspaceId: string }

/**
 * The owner of a valid token, or null (bad shape, unknown, revoked or expired).
 * Looks up by hash, so the plaintext is never compared or stored; bumps
 * lastUsedAt at most once a minute. Membership is re-checked by callers.
 */
export async function verifyPersonalAccessToken(token: string, now = new Date()): Promise<TokenPrincipal | null> {
  if (!PAT_SHAPE.test(token)) return null
  return guardTokenDb(async () => {
  const [row] = await db.update(personalAccessTokens).set({ lastUsedAt: now })
    .where(and(
      eq(personalAccessTokens.tokenHash, hashPersonalAccessToken(token)),
      isNull(personalAccessTokens.revokedAt),
      sql`(${personalAccessTokens.expiresAt} is null or ${personalAccessTokens.expiresAt} > ${now})`,
      sql`(${personalAccessTokens.lastUsedAt} is null or ${personalAccessTokens.lastUsedAt} < ${now}::timestamptz - interval '1 minute')`,
    ))
    .returning({ tokenId: personalAccessTokens.id, userId: personalAccessTokens.userId, workspaceId: personalAccessTokens.workspaceId })
  if (row) return row
  // Used within the last minute: still valid, just no write.
  const [recent] = await db.select({ tokenId: personalAccessTokens.id, userId: personalAccessTokens.userId, workspaceId: personalAccessTokens.workspaceId })
    .from(personalAccessTokens)
    .where(and(eq(personalAccessTokens.tokenHash, hashPersonalAccessToken(token)), isNull(personalAccessTokens.revokedAt),
      sql`(${personalAccessTokens.expiresAt} is null or ${personalAccessTokens.expiresAt} > ${now})`)).limit(1)
  return recent ?? null
  })
}
