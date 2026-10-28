import 'server-only'
import { Composio, ComposioConnectedAccountNotRevokableError, ComposioConnectedAccountRevocationNotSupportedError } from '@composio/core'
import { executeComposioAction, type ComposioActionName, type ComposioActionResult } from '@/lib/composio-actions'
import { COMPOSIO_APP_IDS, disconnectComposioAccount, PROVIDER_IDENTITY, providerAnswer, SLACK_USER_INFO, sanitizeEmail, slackUserEmail, slackUserId, type ComposioAppId } from '@/lib/composio-accounts'
import { chosenComposioDefault, forgetComposioAccount } from '@/lib/composio-account-store'

export const COMPOSIO_TOOLKITS = COMPOSIO_APP_IDS
export type ComposioToolkit = ComposioAppId

export function getComposio() {
  const apiKey = process.env.COMPOSIO_API_KEY
  return apiKey ? new Composio({ apiKey }) : null
}

export function runComposioAction(userId: string, action: ComposioActionName, input: unknown): Promise<ComposioActionResult> {
  return executeComposioAction(userId, action, input, getComposio(), toolkit => chosenComposioDefault(userId, toolkit))
}

export function isComposioToolkit(value: string): value is ComposioToolkit {
  return (COMPOSIO_TOOLKITS as readonly string[]).includes(value)
}

type ComposioClient = NonNullable<ReturnType<typeof getComposio>>

/**
 * Sets a connected account's alias through Composio's
 * `PATCH /connected_accounts/{id}` (the SDK's `update` only takes `enabled`).
 * An alias is unique per user and toolkit; see `isDuplicateAliasError`.
 */
export async function renameComposioAccount(composio: ComposioClient, id: string, alias: string) {
  await composio.getClient().connectedAccounts.patch(id, { alias })
}

/** Revoke cannot be done for this account: the provider has no revocation API, or the account is not in a revokable state. */
export function cannotRevokeComposioAccount(error: unknown) {
  return error instanceof ComposioConnectedAccountRevocationNotSupportedError || error instanceof ComposioConnectedAccountNotRevokableError
}

/**
 * The account's email as the provider reports it, through Composio's proxy
 * with the account's own token. Null is a final answer: a 2xx without an
 * email, or a 403. Throws on anything else (429, 5xx, network, timeout) so
 * callers try again later. Only the sanitised
 * address is returned.
 */
export async function readComposioAccountEmail(composio: ComposioClient, userId: string, toolkit: ComposioAppId, accountId: string, timeoutMs = 8_000): Promise<string | null> {
  const identity = PROVIDER_IDENTITY[toolkit]
  const signal = AbortSignal.timeout(timeoutMs)
  const call = async (endpoint: string, parameters: { in: 'query' | 'header'; name: string; value: string }[] = []) => {
    const response = await composio.tools.proxyExecute({ endpoint, method: 'GET', connectedAccountId: accountId, userId, parameters }, { signal })
    return providerAnswer(response.status, response.data)
  }
  const data = await call(identity.endpoint, Object.entries(identity.headers ?? {}).map(([name, value]) => ({ in: 'header' as const, name, value })))
  if (toolkit !== 'slack') return sanitizeEmail(identity.email(data))
  const user = slackUserId(identity.email(data))
  return user ? sanitizeEmail(slackUserEmail(await call(SLACK_USER_INFO, [{ in: 'query', name: 'user', value: user }]))) : null
}

/**
 * Disconnects one of the person's accounts and forgets Mikka's notes on it.
 * Its alias is cleared first so the account that replaces it can take it.
 */
export async function retireComposioAccount(composio: ComposioClient, userId: string, accountId: string) {
  await renameComposioAccount(composio, accountId, '').catch(() => undefined)
  await disconnectComposioAccount(composio.connectedAccounts, accountId, cannotRevokeComposioAccount)
  await forgetComposioAccount(userId, accountId)
}
