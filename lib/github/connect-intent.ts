import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

/**
 * Plugins → GitHub from the desktop app (2026-11-03): the authorization runs in
 * the system browser, whose Mikka session may be another account. The app first
 * takes a token naming its own account; the browser starts GitHub only when its
 * session is that account. The token grants nothing by itself: it is single
 * use, lives ten minutes, is stored only as a hash, and a browser signed in as
 * anyone else can neither use it nor learn more than a masked address.
 */
export const INTENT_TTL_MS = 10 * 60_000
const TOKEN = /^ghi_[A-Za-z0-9_-]{43}$/

type Query = Pick<Pool, 'query'>
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
export const isIntentToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value)

/** A new token for the signed-in app's own account. */
export async function createConnectIntent(query: Query, userId: string, now = new Date()) {
  const token = `ghi_${randomBytes(32).toString('base64url')}`
  await query.query('DELETE FROM github_connect_intents WHERE "userId"=$1 AND "expiresAt" < $2', [userId, now])
  await query.query('INSERT INTO github_connect_intents ("tokenHash","userId","expiresAt") VALUES ($1,$2,$3)', [hash(token), userId, new Date(now.getTime() + INTENT_TTL_MS)])
  return { token, expiresAt: new Date(now.getTime() + INTENT_TTL_MS).toISOString() }
}

export type ClaimResult = { kind: 'start' } | { kind: 'otherAccount' } | { kind: 'expired' }

/**
 * The browser opened the link: start GitHub for the token's account when the
 * browser is signed in as it (once), or record which account the browser has.
 * A mismatch does not use the token, so the same link works after switching.
 */
export async function claimConnectIntent(query: Query, token: string, browserUserId: string, now = new Date()): Promise<ClaimResult> {
  if (!isIntentToken(token)) return { kind: 'expired' }
  const { rows: [row] } = await query.query<{ userId: string }>('SELECT "userId" FROM github_connect_intents WHERE "tokenHash"=$1 AND "usedAt" IS NULL AND "expiresAt" > $2', [hash(token), now])
  if (!row) return { kind: 'expired' }
  if (row.userId !== browserUserId) {
    await query.query('UPDATE github_connect_intents SET "browserUserId"=$2 WHERE "tokenHash"=$1 AND "usedAt" IS NULL', [hash(token), browserUserId])
    return { kind: 'otherAccount' }
  }
  const used = await query.query('UPDATE github_connect_intents SET "usedAt"=$3,"browserUserId"=NULL WHERE "tokenHash"=$1 AND "userId"=$2 AND "usedAt" IS NULL AND "expiresAt" > $3', [hash(token), browserUserId, now])
  return used.rowCount ? { kind: 'start' } : { kind: 'expired' }
}

/** `al•••@acme.example`: enough for the person to recognise their own account. */
export function maskEmail(email: string) {
  const at = email.lastIndexOf('@')
  if (at < 1) return '•••'
  return `${email.slice(0, Math.min(2, at))}•••${email.slice(at)}`
}

export type IntentView =
  | { state: 'expired' }
  /** The app's own view: its link is waiting, in use, or the browser is signed in as another account. */
  | { state: 'waiting' | 'started'; browserAccount: string | null }
  /** The browser's view after a mismatch: its own account, and the app's, masked. */
  | { state: 'otherAccount'; browserAccount: string; appAccount: string }

/** What the app or the browser shows about one token. Anyone else learns nothing. */
export async function readConnectIntent(query: Query, token: string, viewerId: string, now = new Date()): Promise<IntentView> {
  if (!isIntentToken(token)) return { state: 'expired' }
  const { rows: [row] } = await query.query<{ userId: string; usedAt: Date | null; browserUserId: string | null; ownerEmail: string; browserEmail: string | null }>(
    `SELECT i."userId",i."usedAt",i."browserUserId",o.email AS "ownerEmail",b.email AS "browserEmail"
     FROM github_connect_intents i JOIN "user" o ON o.id=i."userId" LEFT JOIN "user" b ON b.id=i."browserUserId"
     WHERE i."tokenHash"=$1 AND i."expiresAt" > $2`, [hash(token), now])
  if (!row) return { state: 'expired' }
  if (viewerId === row.userId) {
    if (row.usedAt) return { state: 'started', browserAccount: null }
    // The same person signed in to their own account in the browser too: the browser page offers to go on.
    return row.browserUserId ? { state: 'waiting', browserAccount: row.browserEmail } : { state: 'waiting', browserAccount: null }
  }
  if (!row.usedAt && viewerId === row.browserUserId && row.browserEmail) return { state: 'otherAccount', browserAccount: row.browserEmail, appAccount: maskEmail(row.ownerEmail) }
  return { state: 'expired' }
}
