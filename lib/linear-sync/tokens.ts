import 'server-only'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { linearConnections } from '@/lib/db/schema'
import { seal, unseal } from './crypto'
import { LinearApiError } from './graphql'

const tokenPayload = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive() })

export function oauthCredentials() {
  const clientId = process.env.LINEAR_CLIENT_ID
  const clientSecret = process.env.LINEAR_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Linear OAuth is not configured')
  return { clientId, clientSecret }
}

export async function postToken(form: URLSearchParams) {
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

/** A plain row read: no `for update`, so nothing is held while a refresh talks
 * to the provider and every other request can still read this token row. */
async function storedConnection(userId: string) {
  const [row] = await db.select().from(linearConnections).where(eq(linearConnections.userId, userId)).limit(1)
  if (!row || row.revokedAt) throw new Error('Linear connection is unavailable')
  return row
}

export async function linearAccessToken(userId: string) {
  const row = await storedConnection(userId)
  if (row.expiresAt.getTime() > Date.now() + 60_000) return unseal(row.accessToken)
  let token: Awaited<ReturnType<typeof postToken>>
  try {
    token = await postToken(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: unseal(row.refreshToken) }))
  } catch (error) {
    // Linear rotates refresh tokens, so a concurrent refresh may have spent the
    // one just sent. If it stored its own, that is the credential to use.
    const current = await storedConnection(userId)
    if (current.refreshToken !== row.refreshToken) return unseal(current.accessToken)
    // An unchanged row settles nothing: the request that spent this token may be
    // waiting on that same provider, or on the write that follows its answer. Only
    // the next read can tell, so the refusal is reported as retryable. Settling it
    // here would let an ordinary race fail a live connection for good.
    throw error instanceof LinearApiError && !error.retryable
      ? new LinearApiError(`${error.message} (a concurrent refresh may have spent this token)`, true, error.status)
      : error
  }
  // Compare-and-set on the refresh token that was read: the refresh runs outside
  // any transaction, so a row lock cannot be held across the provider call and
  // this write applies only while no other request has rotated that credential.
  const [written] = await db.update(linearConnections).set({
    accessToken: seal(token.access_token),
    refreshToken: seal(token.refresh_token),
    expiresAt: new Date(Date.now() + token.expires_in * 1000),
    updatedAt: new Date(),
  }).where(and(eq(linearConnections.userId, userId), eq(linearConnections.refreshToken, row.refreshToken)))
    .returning({ userId: linearConnections.userId })
  // Another request won the rotation: use what it stored instead of overwriting it.
  if (!written) return unseal((await storedConnection(userId)).accessToken)
  return token.access_token
}
