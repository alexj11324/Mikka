import { z } from 'zod'

// What the plugins page shows for a Composio connected account, and the few
// rules around it, kept free of the SDK so they can be tested on their own.

export const COMPOSIO_APP_IDS = ['gmail', 'googlecalendar', 'notion', 'slack'] as const
export type ComposioAppId = (typeof COMPOSIO_APP_IDS)[number]

/**
 * Composio statuses that are not an account the person has: a link that was
 * opened and never finished (INITIALIZING, INITIATED) or one that was already
 * disconnected (REVOKED).
 */
const HIDDEN_STATUSES = new Set(['INITIALIZING', 'INITIATED', 'REVOKED'])

export type ConnectedAccountView = {
  id: string
  toolkit: ComposioAppId
  /** Composio status: ACTIVE, INACTIVE, EXPIRED or FAILED once hidden ones are dropped. */
  status: string
  /** Composio's own switch (`isDisabled`). Disabled accounts are skipped by actions and triggers. */
  enabled: boolean
  alias: string | null
  createdAt: string
}

type ComposioAccountLike = {
  id: string
  status: string
  isDisabled: boolean
  alias?: string | null
  createdAt: string
  toolkit: { slug: string }
}

function isAppId(value: string): value is ComposioAppId {
  return (COMPOSIO_APP_IDS as readonly string[]).includes(value)
}

/**
 * The account as the page shows it, or null when it is not one of our apps or
 * not a real account yet. Only these fields leave the server; credentials in
 * `state` and `data` never do.
 */
export function toConnectedAccountView(account: ComposioAccountLike): ConnectedAccountView | null {
  if (!isAppId(account.toolkit.slug) || HIDDEN_STATUSES.has(account.status)) return null
  const alias = account.alias?.trim() || null
  return { id: account.id, toolkit: account.toolkit.slug, status: account.status, enabled: !account.isDisabled, alias, createdAt: account.createdAt }
}

/** Connect and reconnect both go to Composio's hosted connect page, over HTTPS. */
export function composioConnectRedirect(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'connect.composio.dev' ? url : null
  } catch {
    return null
  }
}

/**
 * Set by a reconnect and read by the callback: once the new connection
 * completes, the account it replaces is disconnected.
 */
export const COMPOSIO_REPLACE_COOKIE = 'mikka_composio_replace'

export const accountAliasSchema = z.string().trim().min(1).max(60)

export const accountUpdateSchema = z.union([
  z.object({ accountId: z.string().trim().min(1).max(255), enabled: z.boolean() }).strict(),
  z.object({ accountId: z.string().trim().min(1).max(255), alias: accountAliasSchema }).strict(),
])

type RevokeApi = {
  revoke: (id: string) => Promise<unknown>
  delete: (id: string) => Promise<unknown>
}

/**
 * Disconnects an account: revoke the tokens at the provider, which leaves it
 * REVOKED (hidden from the page). When the provider cannot revoke
 * programmatically or the account is in a state that cannot be revoked,
 * delete it on Composio instead, which drops the stored tokens.
 */
export async function disconnectComposioAccount(api: RevokeApi, id: string, cannotRevoke: (error: unknown) => boolean) {
  try {
    await api.revoke(id)
  } catch (error) {
    if (!cannotRevoke(error)) throw error
    await api.delete(id)
  }
}
