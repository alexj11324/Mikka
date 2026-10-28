import 'server-only'
import { Composio } from '@composio/core'
import { COMPOSIO_ACTIONS, executeComposioAction, resolveComposioAccount, type ComposioActionName, type ComposioActionResult } from '@/lib/composio-actions'
import { COMPOSIO_APP_IDS, revokeAndForgetAccount, PROVIDER_IDENTITY, providerAnswer, SLACK_USER_INFO, sanitizeEmail, slackUserEmail, slackUserId, type ComposioAppId } from '@/lib/composio-accounts'
import { chosenComposioDefault, forgetComposioAccount } from '@/lib/composio-account-store'

export const COMPOSIO_TOOLKITS = COMPOSIO_APP_IDS
export type ComposioToolkit = ComposioAppId

export function getComposio() {
  const apiKey = process.env.COMPOSIO_API_KEY
  return apiKey ? new Composio({ apiKey }) : null
}

export function runComposioAction(userId: string, action: ComposioActionName, input: unknown, accountId?: string): Promise<ComposioActionResult> {
  return executeComposioAction(userId, action, input, getComposio(), toolkit => chosenComposioDefault(userId, toolkit), accountId)
}

export async function resolveActionAccount(userId: string, action: ComposioActionName, accountId?: string) {
  const composio = getComposio()
  if (!composio) return { accountId: null, accounts: [] }
  return resolveComposioAccount(userId, COMPOSIO_ACTIONS[action].toolkit, composio, toolkit => chosenComposioDefault(userId, toolkit), accountId)
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
 * The alias is cleared only after revocation succeeds, so a failed revoke
 * leaves the old account name intact.
 */
export async function retireComposioAccount(composio: ComposioClient, userId: string, accountId: string, alias?: string | null) {
  await revokeAndForgetAccount({
    revoke: () => composio.connectedAccounts.revoke(accountId),
    clearAlias: () => renameComposioAccount(composio, accountId, ''),
    forget: () => forgetComposioAccount(userId, accountId),
  }, Boolean(alias))
}
