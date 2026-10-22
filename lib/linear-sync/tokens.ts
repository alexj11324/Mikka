import 'server-only'
import { eq } from 'drizzle-orm'
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
