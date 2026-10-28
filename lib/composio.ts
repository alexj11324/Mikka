import 'server-only'
import { Composio, ComposioConnectedAccountNotRevokableError, ComposioConnectedAccountRevocationNotSupportedError } from '@composio/core'
import { executeComposioAction, type ComposioActionName, type ComposioActionResult } from '@/lib/composio-actions'
import { COMPOSIO_APP_IDS, type ComposioAppId } from '@/lib/composio-accounts'

export const COMPOSIO_TOOLKITS = COMPOSIO_APP_IDS
export type ComposioToolkit = ComposioAppId

export function getComposio() {
  const apiKey = process.env.COMPOSIO_API_KEY
  return apiKey ? new Composio({ apiKey }) : null
}

export function runComposioAction(userId: string, action: ComposioActionName, input: unknown): Promise<ComposioActionResult> {
  return executeComposioAction(userId, action, input, getComposio())
}

export function isComposioToolkit(value: string): value is ComposioToolkit {
  return (COMPOSIO_TOOLKITS as readonly string[]).includes(value)
}

/**
 * Sets a connected account's alias. The SDK (0.26) only patches `enabled`, so
 * this calls Composio's `PATCH /api/v3.1/connected_accounts/{id}`, which takes
 * `alias` (unique per user and toolkit).
 */
export async function renameComposioAccount(id: string, alias: string) {
  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey) throw new Error('Composio is not configured')
  const base = process.env.COMPOSIO_BASE_URL || 'https://backend.composio.dev'
  const response = await fetch(new URL(`/api/v3.1/connected_accounts/${encodeURIComponent(id)}`, base), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ alias }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Composio rename failed (${response.status})`)
}

/** Revoke cannot be done for this account: the provider has no revocation API, or the account is not in a revokable state. */
export function cannotRevokeComposioAccount(error: unknown) {
  return error instanceof ComposioConnectedAccountRevocationNotSupportedError || error instanceof ComposioConnectedAccountNotRevokableError
}
