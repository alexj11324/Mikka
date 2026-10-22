import 'server-only'
import { randomBytes, createHash } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { linearConnections, linearOAuthStates, linearTeamSyncs } from '@/lib/db/schema'
import { authBaseURL } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { hashValue, seal, unseal } from './crypto'
import { linearIdentity } from './client'
import { LinearApiError } from './graphql'

const tokenPayload = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive() })
export const LINEAR_OAUTH_STATE_COOKIE = 'linear-oauth-state'
export const LINEAR_OAUTH_CALLBACK_PATH = withBasePath('/api/integrations/linear/callback')

export function linearRedirectUrl() {
  const fallback = process.env.VERCEL_ENV === 'preview'
    ? ''
    : authBaseURL ? new URL(LINEAR_OAUTH_CALLBACK_PATH, authBaseURL).toString() : ''
  const value = process.env.LINEAR_REDIRECT_URL ?? fallback
  if (!value) throw new Error('Linear OAuth is not configured')
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('Linear redirect URL must use HTTPS')
  return url.toString()
}

export function linearOAuthConfigured() {
  if (!process.env.LINEAR_CLIENT_ID || !process.env.LINEAR_CLIENT_SECRET || !/^[a-f\d]{64}$/i.test(process.env.LINEAR_TOKEN_ENCRYPTION_KEY ?? '') || !process.env.LINEAR_WEBHOOK_SECRET || !process.env.CRON_SECRET) return false
  try { linearRedirectUrl(); return true } catch { return false }
}

function oauthCredentials() {
  const clientId = process.env.LINEAR_CLIENT_ID
  const clientSecret = process.env.LINEAR_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Linear OAuth is not configured')
  return { clientId, clientSecret }
}

export async function createLinearAuthorizationUrl(userId: string) {
  const { clientId } = oauthCredentials()
  const redirectUri = linearRedirectUrl()
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  await db.delete(linearOAuthStates).where(and(eq(linearOAuthStates.userId, userId), lt(linearOAuthStates.expiresAt, new Date())))
  await db.insert(linearOAuthStates).values({ stateHash: hashValue(state), userId, verifier: seal(verifier), expiresAt: new Date(Date.now() + 10 * 60_000) })
  const url = new URL('https://linear.app/oauth/authorize')
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'read,write,issues:create,comments:create',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  }).toString()
  return { url: url.toString(), state }
}

async function postToken(form: URLSearchParams) {
  const { clientId, clientSecret } = oauthCredentials()
  form.set('client_id', clientId)
  form.set('client_secret', clientSecret)
  let response: Response
  try {
    response = await fetch('https://api.linear.app/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new LinearApiError('Could not reach Linear OAuth', true)
  }
  if (!response.ok) throw new LinearApiError('Linear OAuth token exchange failed', response.status >= 500 || response.status === 429, response.status)
  return tokenPayload.parse(await response.json())
}

export async function exchangeLinearCode(state: string, code: string, userId: string) {
  const redirectUri = linearRedirectUrl()
  const grant = await db.transaction(async tx => {
    const [row] = await tx.select().from(linearOAuthStates).where(and(eq(linearOAuthStates.stateHash, hashValue(state)), eq(linearOAuthStates.userId, userId), gt(linearOAuthStates.expiresAt, new Date()))).for('update').limit(1)
    if (!row || row.expiresAt <= new Date()) throw new Error('Linear OAuth state is invalid or expired')
    await tx.delete(linearOAuthStates).where(eq(linearOAuthStates.stateHash, row.stateHash))
    return { userId: row.userId, verifier: unseal(row.verifier) }
  })
  const token = await postToken(new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: grant.verifier }))
  const identity = await linearIdentity(token.access_token)
  const old = await db.select({ organizationId: linearConnections.organizationId }).from(linearConnections).where(eq(linearConnections.userId, grant.userId)).limit(1)
  await db.transaction(async tx => {
    if (old[0] && old[0].organizationId !== identity.organization.id) {
      await tx.update(linearTeamSyncs).set({ active: false, updatedAt: new Date() }).where(eq(linearTeamSyncs.ownerId, grant.userId))
    }
    await tx.insert(linearConnections).values({
      userId: grant.userId,
      linearUserId: identity.user.id,
      organizationId: identity.organization.id,
      organizationName: identity.organization.name,
      accessToken: seal(token.access_token),
      refreshToken: seal(token.refresh_token),
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
    }).onConflictDoUpdate({
      target: linearConnections.userId,
      set: {
        linearUserId: identity.user.id,
        organizationId: identity.organization.id,
        organizationName: identity.organization.name,
        accessToken: seal(token.access_token),
        refreshToken: seal(token.refresh_token),
        expiresAt: new Date(Date.now() + token.expires_in * 1000),
        revokedAt: null,
        updatedAt: new Date(),
      },
    })
  })
  return grant.userId
}

export async function linearAccessToken(userId: string) {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(linearConnections).where(eq(linearConnections.userId, userId)).for('update').limit(1)
    if (!row || row.revokedAt) throw new Error('Linear connection is unavailable')
    if (row.expiresAt.getTime() > Date.now() + 60_000) return unseal(row.accessToken)
    const token = await postToken(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: unseal(row.refreshToken) }))
    await tx.update(linearConnections).set({
      accessToken: seal(token.access_token),
      refreshToken: seal(token.refresh_token),
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
      updatedAt: new Date(),
    }).where(eq(linearConnections.userId, userId))
    return token.access_token
  })
}

export async function disconnectLinear(userId: string) {
  const [row] = await db.select({ refreshToken: linearConnections.refreshToken }).from(linearConnections).where(eq(linearConnections.userId, userId)).limit(1)
  if (row) {
    try {
      const { clientId, clientSecret } = oauthCredentials()
      await fetch('https://api.linear.app/oauth/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token: unseal(row.refreshToken), token_type_hint: 'refresh_token' }),
        signal: AbortSignal.timeout(5_000),
      })
    } catch { /* Local disconnect still removes this app's stored access. */ }
  }
  await db.transaction(async tx => {
    await tx.update(linearTeamSyncs).set({ active: false, updatedAt: new Date() }).where(eq(linearTeamSyncs.ownerId, userId))
    await tx.delete(linearConnections).where(eq(linearConnections.userId, userId))
  })
}
