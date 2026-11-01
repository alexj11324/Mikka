import 'server-only'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { AuthContext } from 'better-auth'
import { decryptOAuthToken, setTokenUtil } from 'better-auth/oauth2'
import { db } from '@/lib/db'
import { githubConnections } from '@/lib/db/schema'
import { auth } from '@/lib/auth'
import { authOAuthProxyOptions, resolveAppOrigin } from '@/lib/auth-config'
import { withBasePath } from '@/lib/base-path'

// Plugins → GitHub connects a GitHub account for repository access without
// touching the Better Auth login identity. It reuses the GitHub App's one
// registered callback URL; the auth route hands a callback to this module only
// when its state matches the cookie set here.
export const GITHUB_CONNECT_COOKIE = 'mikka-github-connect'
export const GITHUB_CALLBACK_PATH = withBasePath('/api/auth/callback/github')
const STATE_TTL_SECONDS = 600

export type GitHubConnection = { githubAccountId: string; githubLogin: string }
type TokenResponse = { access_token: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number }

// The same origin Better Auth registers its GitHub callback on (lib/auth.ts).
const callbackBase = () => authOAuthProxyOptions(process.env)?.productionURL ?? resolveAppOrigin(process.env)

function callbackURL() {
  const base = callbackBase()
  if (!base) throw new Error('GitHub connection has no callback origin')
  return new URL(GITHUB_CALLBACK_PATH, base).toString()
}

export function githubConnectConfigured() {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && callbackBase())
}

export function startGitHubConnect(userId: string) {
  const state = `ghc_${randomBytes(32).toString('base64url')}`
  const url = new URL('https://github.com/login/oauth/authorize')
  url.search = new URLSearchParams({ client_id: process.env.GITHUB_CLIENT_ID!, redirect_uri: callbackURL(), state, allow_signup: 'false' }).toString()
  return {
    url: url.toString(),
    cookie: { name: GITHUB_CONNECT_COOKIE, value: `${state}.${userId}`, options: { httpOnly: true, sameSite: 'lax' as const, secure: callbackURL().startsWith('https:'), path: GITHUB_CALLBACK_PATH, maxAge: STATE_TTL_SECONDS } },
  }
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
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mikka' },
    body: new URLSearchParams({ client_id: process.env.GITHUB_CLIENT_ID!, client_secret: process.env.GITHUB_CLIENT_SECRET!, ...params }),
  })
  const body = await response.json().catch(() => null) as Partial<TokenResponse> | null
  if (!response.ok || typeof body?.access_token !== 'string' || !body.access_token) throw new Error('GitHub token exchange failed')
  return body as TokenResponse
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
  const values = { ...identity, ...await sealedTokens(token), updatedAt: new Date() }
  await db.insert(githubConnections).values({ userId, ...values }).onConflictDoUpdate({ target: githubConnections.userId, set: values })
}

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

/** A usable user token for this user's connection, refreshed when it has expired; null without a connection. */
export async function githubConnectionToken(userId: string): Promise<{ token: string; githubAccountId: string } | null> {
  const [row] = await db.select().from(githubConnections).where(eq(githubConnections.userId, userId)).limit(1)
  if (!row) return null
  if (!row.accessTokenExpiresAt || row.accessTokenExpiresAt.getTime() > Date.now() + 60_000) {
    return { token: await unseal(row.accessToken), githubAccountId: row.githubAccountId }
  }
  if (!row.refreshToken || (row.refreshTokenExpiresAt && row.refreshTokenExpiresAt.getTime() <= Date.now())) throw new Error('GitHub connection expired')
  const token = await postToken({ grant_type: 'refresh_token', refresh_token: await unseal(row.refreshToken) })
  await db.update(githubConnections).set({ ...await sealedTokens(token), updatedAt: new Date() }).where(eq(githubConnections.userId, userId))
  return { token: token.access_token, githubAccountId: row.githubAccountId }
}
