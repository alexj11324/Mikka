import 'server-only'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { AuthContext } from 'better-auth'
import { decryptOAuthToken, setTokenUtil } from 'better-auth/oauth2'
import { db } from '@/lib/db'
import { githubConnections } from '@/lib/db/schema'
import { auth } from '@/lib/auth'
import { resolveAppOrigin } from '@/lib/auth-config'
import { withBasePath } from '@/lib/base-path'
import { readGitHubAppConfig } from './app-config'
import { GitHubAccessError } from './user-access-error'
import { exchangeGitHubOAuthToken, type GitHubOAuthToken } from './oauth-token'
import { remainingRequestBudget, type RequestBudget } from '../request-budget'

// Plugins → GitHub connects a GitHub account for repository access without
// touching the Better Auth login identity. It reuses the GitHub App's callback
// path on this deployment's origin; the auth route hands a callback to this
// module only when its state matches the cookie set here (or a loopback link).
export const GITHUB_CONNECT_COOKIE = 'mikka-github-connect'
export const GITHUB_CALLBACK_PATH = withBasePath('/api/auth/callback/github')
const STATE_TTL_SECONDS = 600

export type GitHubConnection = { githubAccountId: string; githubLogin: string }
type TokenResponse = GitHubOAuthToken

// The origin the link starts on, never the sign-in proxy hub: the proxy relays
// sign-in only, and a preview's link landing on the hub would reach production
// with a state production does not hold (decision 2026-11-03-0315). An origin
// the GitHub App has not registered gets GitHub's redirect_uri error.
const callbackBase = () => resolveAppOrigin(process.env)

function callbackURL() {
  const base = callbackBase()
  if (!base) throw new Error('GitHub connection has no callback origin')
  return new URL(GITHUB_CALLBACK_PATH, base).toString()
}

export async function githubConnectConfigured() {
  const config = await readGitHubAppConfig()
  return Boolean(config.clientId && config.clientSecret && callbackBase())
}

async function connectionClient() {
  const config = await readGitHubAppConfig()
  if (!config.clientId || !config.clientSecret) throw new GitHubAccessError('githubNotConfigured', 503)
  return { clientId: config.clientId, clientSecret: config.clientSecret }
}

export async function startGitHubConnect(userId: string) {
  const { clientId } = await connectionClient()
  const state = `ghc_${randomBytes(32).toString('base64url')}`
  const url = new URL('https://github.com/login/oauth/authorize')
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: callbackURL(), state, allow_signup: 'false' }).toString()
  return {
    url: url.toString(),
    cookie: { name: GITHUB_CONNECT_COOKIE, value: `${state}.${userId}`, options: { httpOnly: true, sameSite: 'lax' as const, secure: callbackURL().startsWith('https:'), path: GITHUB_CALLBACK_PATH, maxAge: STATE_TTL_SECONDS } },
  }
}

/**
 * GitHub's authorization for a desktop link (lib/github/connect-intent.ts): its
 * own state, and PKCE with S256, which GitHub supports for GitHub App user
 * authorization ("strongly recommended", plain is not supported).
 */
export async function githubAuthorizeURL(state: string, codeChallenge: string) {
  const { clientId } = await connectionClient()
  const url = new URL('https://github.com/login/oauth/authorize')
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: callbackURL(), state, allow_signup: 'false', code_challenge: codeChallenge, code_challenge_method: 'S256' }).toString()
  return url.toString()
}

/** The user who started this connect flow, when the callback's state is ours. */
export function githubConnectUser(state: string | null, cookie: string | undefined): string | null {
  if (!state?.startsWith('ghc_') || !cookie) return null
  const dot = cookie.indexOf('.')
  if (dot < 0) return null
  const expected = Buffer.from(cookie.slice(0, dot)), actual = Buffer.from(state)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  return cookie.slice(dot + 1) || null
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  return exchangeGitHubOAuthToken(await connectionClient(), params)
}

async function githubUser(token: string): Promise<GitHubConnection> {
  const response = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Mikka' },
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json().catch(() => null) as { id?: unknown; login?: unknown } | null
  if (!response.ok || !Number.isSafeInteger(body?.id) || Number(body?.id) <= 0 || typeof body?.login !== 'string' || !body.login) throw new Error('GitHub user lookup failed')
  return { githubAccountId: String(body.id), githubLogin: body.login }
}

const expiry = (seconds: number | undefined, now: number) => typeof seconds === 'number' && seconds > 0 ? new Date(now + seconds * 1000) : null

// Sealed exactly like Better Auth's own account tokens (encryptOAuthTokens, BETTER_AUTH_SECRET).
const authContext = async () => await auth.$context as unknown as AuthContext
const seal = async (value: string) => String(await setTokenUtil(value, await authContext()))
const unseal = async (value: string) => String(await decryptOAuthToken(value, await authContext()))

async function sealedTokens(token: TokenResponse) {
  const now = Date.now()
  return {
    accessToken: await seal(token.access_token),
    refreshToken: token.refresh_token ? await seal(token.refresh_token) : null,
    accessTokenExpiresAt: expiry(token.expires_in, now),
    refreshTokenExpiresAt: expiry(token.refresh_token_expires_in, now),
  }
}

/** Store (or replace) this user's connection. Other users' connections to the same GitHub account are untouched. */
export async function saveGitHubConnection(userId: string, identity: GitHubConnection, token: TokenResponse) {
  await saveSealedGitHubConnection(userId, identity, await sealedTokens(token))
}

export type SealedGitHubTokens = Awaited<ReturnType<typeof sealedTokens>>

/** The same, from tokens already sealed (a desktop link's answer that waited for the app). */
export async function saveSealedGitHubConnection(userId: string, identity: GitHubConnection, sealed: SealedGitHubTokens) {
  const values = { ...identity, ...sealed, updatedAt: new Date() }
  await db.insert(githubConnections).values({ userId, ...values }).onConflictDoUpdate({ target: githubConnections.userId, set: values })
}

/** A desktop link's code: exchanged with its PKCE verifier; the answer comes back sealed, not stored. */
export async function exchangeGitHubCode(code: string, codeVerifier: string): Promise<{ identity: GitHubConnection; sealed: SealedGitHubTokens }> {
  const token = await postToken({ code, redirect_uri: callbackURL(), code_verifier: codeVerifier })
  return { identity: await githubUser(token.access_token), sealed: await sealedTokens(token) }
}

/** Sealed like the tokens, for the server's own PKCE verifier while GitHub has the person. */
export const sealGitHubSecret = (value: string) => seal(value)
export const unsealGitHubSecret = (value: string) => unseal(value)

export async function completeGitHubConnect(userId: string, code: string) {
  const token = await postToken({ code, redirect_uri: callbackURL() })
  await saveGitHubConnection(userId, await githubUser(token.access_token), token)
}

export async function githubConnection(userId: string): Promise<GitHubConnection | null> {
  const [row] = await db.select({ githubAccountId: githubConnections.githubAccountId, githubLogin: githubConnections.githubLogin }).from(githubConnections).where(eq(githubConnections.userId, userId)).limit(1)
  return row ?? null
}

export async function disconnectGitHub(userId: string) {
  await db.delete(githubConnections).where(eq(githubConnections.userId, userId))
}

/**
 * A usable user token for this user's connection, refreshed when it expires
 * within `minValidityMs`; null without a connection. `expiresAt` is null for a
 * token GitHub gave no expiry.
 */
export async function githubConnectionToken(userId: string, { minValidityMs = 60_000, budget }: { minValidityMs?: number; budget?: RequestBudget } = {}): Promise<{ token: string; githubAccountId: string; expiresAt: Date | null } | null> {
  if (budget) remainingRequestBudget(budget)
  const fresh = (expiresAt: Date | null) => !expiresAt || expiresAt.getTime() > Date.now() + minValidityMs
  const [row] = await db.select().from(githubConnections).where(eq(githubConnections.userId, userId)).limit(1)
  if (!row) return null
  if (fresh(row.accessTokenExpiresAt)) return { token: await unseal(row.accessToken), githubAccountId: row.githubAccountId, expiresAt: row.accessTokenExpiresAt }
  // GitHub rotates the refresh token on use, so concurrent refreshes (several
  // runs of one person) must not each spend it: one holds the row, the others
  // wait and read the token it saved.
  const credential = await db.transaction(async tx => {
    if (budget) {
      const timeout = String(Math.min(2000, remainingRequestBudget(budget)))
      await tx.execute(sql`SELECT set_config('lock_timeout',${timeout},true),set_config('statement_timeout',${timeout},true)`)
    }
    const [locked] = await tx.select().from(githubConnections).where(eq(githubConnections.userId, userId)).for('update')
    if (!locked) return null
    if (fresh(locked.accessTokenExpiresAt)) return { token: await unseal(locked.accessToken), githubAccountId: locked.githubAccountId, expiresAt: locked.accessTokenExpiresAt }
    if (!locked.refreshToken || (locked.refreshTokenExpiresAt && locked.refreshTokenExpiresAt.getTime() <= Date.now())) throw new Error('GitHub connection expired')
    if (budget) remainingRequestBudget(budget, 12_000)
    const token = await postToken({ grant_type: 'refresh_token', refresh_token: await unseal(locked.refreshToken) })
    const sealed = await sealedTokens(token)
    await tx.update(githubConnections).set({ ...sealed, updatedAt: new Date() }).where(eq(githubConnections.userId, userId))
    return { token: token.access_token, githubAccountId: locked.githubAccountId, expiresAt: sealed.accessTokenExpiresAt }
  })
  // Never throw for a caller cancellation inside the refresh transaction.
  if (budget) remainingRequestBudget(budget)
  return credential
}
