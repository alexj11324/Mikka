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

const B64URL_43 = /^[A-Za-z0-9_-]{43}$/
const s256 = (value: string) => createHash('sha256').update(value).digest('base64url')

/** The desktop app's one-shot return listener (RFC 8252 §7.3): http://127.0.0.1:<port>/return, nothing else. */
export function loopbackReturn(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/return') return null
    return `${url.origin}${url.pathname}`
  } catch { return null }
}

/**
 * A desktop app that can take the return on its loopback: where to return, the
 * state its listener expects, and S256 of a verifier only the app holds.
 */
export type LoopbackStart = { returnTo: string; returnState: string; challenge: string }
export function loopbackStart(value: unknown): LoopbackStart | null {
  if (!value || typeof value !== 'object') return null
  const { returnTo, returnState, challenge } = value as Record<string, unknown>
  const to = loopbackReturn(returnTo)
  if (!to || typeof returnState !== 'string' || !B64URL_43.test(returnState) || typeof challenge !== 'string' || !B64URL_43.test(challenge)) return null
  return { returnTo: to, returnState, challenge }
}

/** A new token for the signed-in app's own account; with `loopback`, the link no longer depends on the browser's session. */
export async function createConnectIntent(query: Query, userId: string, now = new Date(), loopback?: LoopbackStart | null) {
  const token = `ghi_${randomBytes(32).toString('base64url')}`
  await query.query('DELETE FROM github_connect_intents WHERE "userId"=$1 AND "expiresAt" < $2', [userId, now])
  await query.query('INSERT INTO github_connect_intents ("tokenHash","userId","expiresAt","returnTo","returnState","appChallenge") VALUES ($1,$2,$3,$4,$5,$6)',
    [hash(token), userId, new Date(now.getTime() + INTENT_TTL_MS), loopback?.returnTo ?? null, loopback?.returnState ?? null, loopback?.challenge ?? null])
  return { token, expiresAt: new Date(now.getTime() + INTENT_TTL_MS).toISOString() }
}

export type GitHubSteps = {
  authorizeURL: (state: string, codeChallenge: string) => string
  exchange: (code: string, codeVerifier: string) => Promise<{ identity: { githubAccountId: string; githubLogin: string }; sealed: { accessToken: string; refreshToken: string | null; accessTokenExpiresAt: Date | null; refreshTokenExpiresAt: Date | null } }>
  seal: (value: string) => Promise<string>
  unseal: (value: string) => Promise<string>
  save: (userId: string, identity: { githubAccountId: string; githubLogin: string }, sealed: { accessToken: string; refreshToken: string | null; accessTokenExpiresAt: Date | null; refreshTokenExpiresAt: Date | null }) => Promise<void>
}

/**
 * The browser opened a loopback link: straight on to GitHub, whoever the
 * browser is signed in as (or no one), once. Null when the token is not a
 * loopback link, so the route keeps the session check for older apps.
 */
export async function startLoopbackIntent(query: Query, token: string, steps: Pick<GitHubSteps, 'authorizeURL' | 'seal'>, now = new Date()): Promise<{ kind: 'github'; url: string } | { kind: 'expired' } | null> {
  if (!isIntentToken(token)) return null
  const { rows: [row] } = await query.query<{ appChallenge: string | null }>('SELECT "appChallenge" FROM github_connect_intents WHERE "tokenHash"=$1', [hash(token)])
  if (!row?.appChallenge) return null
  const state = `ghl_${randomBytes(32).toString('base64url')}`
  const verifier = randomBytes(32).toString('base64url')
  const started = await query.query('UPDATE github_connect_intents SET "usedAt"=$3,"stateHash"=$2,"codeVerifier"=$4 WHERE "tokenHash"=$1 AND "usedAt" IS NULL AND "expiresAt" > $3',
    [hash(token), hash(state), now, await steps.seal(verifier)])
  if (!started.rowCount) return { kind: 'expired' }
  return { kind: 'github', url: steps.authorizeURL(state, s256(verifier)) }
}

export const isLoopbackState = (state: string | null): state is string => typeof state === 'string' && /^ghl_[A-Za-z0-9_-]{43}$/.test(state)

/**
 * GitHub sent the person back with a loopback link's state: exchange the code
 * (with the PKCE verifier) and keep the answer sealed on the link until the app
 * confirms; then send the browser to the app's loopback. Null: not ours.
 */
export async function finishLoopbackIntent(query: Query, state: string, code: string | null, steps: Pick<GitHubSteps, 'exchange' | 'unseal'>, now = new Date()): Promise<{ returnURL: string } | null> {
  if (!isLoopbackState(state)) return null
  const { rows: [row] } = await query.query<{ tokenHash: string; returnTo: string; returnState: string; codeVerifier: string; authorizedAt: Date | null; expiresAt: Date }>(
    'SELECT "tokenHash","returnTo","returnState","codeVerifier","authorizedAt","expiresAt" FROM github_connect_intents WHERE "stateHash"=$1', [hash(state)])
  if (!row) return null
  const back = (result: 'connected' | 'failed' | 'cancelled') => ({ returnURL: `${row.returnTo}?${new URLSearchParams({ state: row.returnState, result })}` })
  if (row.authorizedAt || row.expiresAt <= now) return back('failed')
  if (!code) return back('cancelled')
  try {
    const { identity, sealed } = await steps.exchange(code, await steps.unseal(row.codeVerifier))
    const saved = await query.query(`UPDATE github_connect_intents SET "authorizedAt"=$2,"codeVerifier"=NULL,"githubAccountId"=$3,"githubLogin"=$4,"accessToken"=$5,"refreshToken"=$6,"accessTokenExpiresAt"=$7,"refreshTokenExpiresAt"=$8
      WHERE "tokenHash"=$1 AND "authorizedAt" IS NULL`, [row.tokenHash, now, identity.githubAccountId, identity.githubLogin, sealed.accessToken, sealed.refreshToken, sealed.accessTokenExpiresAt, sealed.refreshTokenExpiresAt])
    return back(saved.rowCount ? 'connected' : 'failed')
  } catch {
    return back('failed')
  }
}

/**
 * The app's loopback got the return, so it was this computer: with the
 * verifier only the app holds, GitHub's answer becomes this account's
 * connection. Anything else (another account, a wrong verifier, no answer yet,
 * already used) links nothing.
 */
export async function confirmLoopbackIntent(query: Query, token: string, verifier: unknown, userId: string, steps: Pick<GitHubSteps, 'save'>, now = new Date()): Promise<{ login: string } | null> {
  if (!isIntentToken(token) || typeof verifier !== 'string' || !B64URL_43.test(verifier)) return null
  const { rows: [row] } = await query.query<{ githubAccountId: string; githubLogin: string; accessToken: string; refreshToken: string | null; accessTokenExpiresAt: Date | null; refreshTokenExpiresAt: Date | null }>(
    // One statement: the row is locked, read and cleared, so two confirms cannot both save it.
    `WITH taken AS (
       SELECT "tokenHash","githubAccountId","githubLogin","accessToken","refreshToken","accessTokenExpiresAt","refreshTokenExpiresAt" FROM github_connect_intents
       WHERE "tokenHash"=$1 AND "userId"=$2 AND "appChallenge"=$3 AND "authorizedAt" IS NOT NULL AND "confirmedAt" IS NULL AND "accessToken" IS NOT NULL AND "expiresAt" > $4 FOR UPDATE),
     cleared AS (UPDATE github_connect_intents i SET "confirmedAt"=$4,"accessToken"=NULL,"refreshToken"=NULL FROM taken WHERE i."tokenHash"=taken."tokenHash" RETURNING i."tokenHash")
     SELECT taken.* FROM taken JOIN cleared USING ("tokenHash")`,
    [hash(token), userId, s256(verifier), now])
  if (!row) return null
  await steps.save(userId, { githubAccountId: row.githubAccountId, githubLogin: row.githubLogin }, { accessToken: row.accessToken, refreshToken: row.refreshToken, accessTokenExpiresAt: row.accessTokenExpiresAt, refreshTokenExpiresAt: row.refreshTokenExpiresAt })
  return { login: row.githubLogin }
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
