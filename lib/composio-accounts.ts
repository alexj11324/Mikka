import { z } from 'zod'

// What the plugins page shows for a Composio connected account, and the few
// rules around it, kept free of the SDK so they can be tested on their own.

export const COMPOSIO_APP_IDS = ['gmail', 'googlecalendar', 'notion', 'slack'] as const
export type ComposioAppId = (typeof COMPOSIO_APP_IDS)[number]
/** Backend catalog. The legacy four-app UI keeps its own presentation list. */
export const COMPOSIO_TOOLKIT_IDS = [...COMPOSIO_APP_IDS, 'googledrive'] as const
export type ComposioToolkitId = (typeof COMPOSIO_TOOLKIT_IDS)[number]

/**
 * Composio statuses that are not an account the person has: a link that was
 * opened and never finished (INITIALIZING, INITIATED) or one that was already
 * disconnected (REVOKED).
 */
const HIDDEN_STATUSES = new Set(['INITIALIZING', 'INITIATED', 'REVOKED'])

export type ConnectedAccountView<Toolkit extends string = ComposioAppId> = {
  id: string
  toolkit: Toolkit
  /** Composio status: ACTIVE, INACTIVE, EXPIRED or FAILED once hidden ones are dropped. */
  status: string
  /** Composio's own switch (`isDisabled`). Disabled accounts are skipped by actions and triggers. */
  enabled: boolean
  alias: string | null
  createdAt: string
  /** The provider's email, read once when the account was connected. */
  email: string | null
  /** The account bots use for this toolkit (see `pickDefaultAccountId`). */
  isDefault: boolean
}

type ComposioAccountLike = {
  id: string
  status: string
  isDisabled: boolean
  alias?: string | null
  createdAt: string
  toolkit: { slug: string }
}

/** A Composio toolkit slug as the catalog lists them (lower case, digits, `_`). */
export const TOOLKIT_SLUG = /^[a-z][a-z0-9_]{0,63}$/
export const isToolkitSlug = (value: unknown): value is string => typeof value === 'string' && TOOLKIT_SLUG.test(value)
/** Mikka's own integrations. The store and account lists show ours, never a Composio copy of them. */
export const OWN_INTEGRATIONS: ReadonlySet<string> = new Set(['github', 'linear', 'telegram'])

/**
 * The account as the page shows it, or null when its toolkit is malformed or
 * one of Mikka's own integrations, or it is not a real account yet. Only these fields leave the server; credentials in
 * `state` and `data` never do.
 */
export function toConnectedAccountView(account: ComposioAccountLike): ConnectedAccountView<string> | null {
  if (!isToolkitSlug(account.toolkit.slug) || OWN_INTEGRATIONS.has(account.toolkit.slug) || HIDDEN_STATUSES.has(account.status)) return null
  const alias = account.alias?.trim() || null
  return { id: account.id, toolkit: account.toolkit.slug, status: account.status, enabled: !account.isDisabled, alias, createdAt: account.createdAt, email: null, isDefault: false }
}

type DefaultCandidate = { id: string; status: string; isDisabled: boolean; createdAt: string }

/**
 * The account bots use for one toolkit: the one the person chose with 设为默认
 * while it is usable (ACTIVE and on). With no choice, a sole usable account
 * is unambiguous; otherwise require a selection rather than changing identity.
 */
export function pickDefaultAccountId(accounts: DefaultCandidate[], chosenId: string | null | undefined) {
  const usable = accounts.filter(account => account.status === 'ACTIVE' && !account.isDisabled)
  if (chosenId) return usable.some(account => account.id === chosenId) ? chosenId : null
  return usable.length === 1 ? usable[0].id : null
}

export type ComposioAccountRecord = {
  accountId: string
  toolkit?: string
  email: string | null
  /** The provider was asked for the email (found or not), so it is not asked again. */
  emailChecked: boolean
  /** The last time the provider was asked, final answer or not; null when never. */
  lastAttemptAt: Date | null
  isDefault: boolean
}

/** Adds what Mikka stores (email, chosen default) to the accounts Composio listed. */
export function withAccountRecords(accounts: ConnectedAccountView<string>[], records: ComposioAccountRecord[]): ConnectedAccountView<string>[] {
  const byId = new Map(records.map(record => [record.accountId, record]))
  const defaults = new Map<string, string | null>()
  for (const app of new Set(accounts.map(account => account.toolkit))) {
    const own = accounts.filter(account => account.toolkit === app)
    const chosen = records.find(record => record.isDefault && (record.toolkit === app || own.some(account => account.id === record.accountId)))?.accountId
    defaults.set(app, pickDefaultAccountId(own.map(account => ({ ...account, isDisabled: !account.enabled })), chosen))
  }
  return accounts.map(account => ({ ...account, email: byId.get(account.id)?.email ?? null, isDefault: defaults.get(account.toolkit) === account.id }))
}

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

/** A plain, lower-cased email address, or null for anything else. */
export function sanitizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.length <= 254 && EMAIL.test(email) ? email : null
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Where each provider says who the account is, read through Composio's proxy
 * with the account's own token. Slack needs two calls: auth.test for the user
 * id, then users.info for that user's email (needs users:read.email).
 */
export const PROVIDER_IDENTITY: Record<ComposioToolkitId, { endpoint: string; headers?: Record<string, string>; email: (data: unknown) => unknown }> = {
  googledrive: { endpoint: 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', email: data => field(data, 'user', 'emailAddress') },
  gmail: { endpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', email: data => field(data, 'emailAddress') },
  // The primary calendar's id is the account's email address.
  googlecalendar: { endpoint: 'https://www.googleapis.com/calendar/v3/calendars/primary', email: data => field(data, 'id') },
  notion: { endpoint: 'https://api.notion.com/v1/users/me', headers: { 'Notion-Version': '2022-06-28' }, email: data => field(data, 'bot', 'owner', 'user', 'person', 'email') },
  slack: { endpoint: 'https://slack.com/api/auth.test', email: data => field(data, 'user_id') },
}

/** The provider could not give a final answer (429, 5xx, 401…); ask again later. */
export class ComposioEmailLookupError extends Error {
  constructor(readonly status: number) {
    super(`Provider answered ${status}`)
    this.name = 'ComposioEmailLookupError'
  }
}

/**
 * Only a successful HTTP response is a final answer. In particular, Google
 * also uses 403 for temporary quota failures, so it cannot mean "no email".
 * Failures are retried after the caller's cooldown.
 */
export function providerAnswer(status: number, data: unknown): unknown {
  if (status >= 200 && status < 300) return data
  throw new ComposioEmailLookupError(status)
}

/** Slack reports API errors inside HTTP 200. Never cache one as "no email". */
export function slackAnswer(data: unknown): unknown {
  if (field(data, 'ok') !== true) throw new ComposioEmailLookupError(200)
  return data
}

export const SLACK_USER_INFO = 'https://slack.com/api/users.info'
export const slackUserEmail = (data: unknown) => field(data, 'user', 'profile', 'email')
export const slackUserId = (value: unknown) => typeof value === 'string' && /^[UW][A-Z0-9]{2,20}$/.test(value) ? value : null

/**
 * A path in this app to come back to after Composio's connect page, without
 * the base path: same origin, not an API route, at most 512 characters.
 * Hash dropped. Null when the value is anything else.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || [...value].some(char => char.charCodeAt(0) < 0x20)) return null
  let url: URL
  try { url = new URL(value, 'https://mikka.invalid') } catch { return null }
  if (url.origin !== 'https://mikka.invalid' || /^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?api(?:\/|$)/.test(url.pathname)) return null
  return `${url.pathname}${url.search}`
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


export const accountAliasSchema = z.string().trim().min(1).max(60)

export const accountUpdateSchema = z.union([
  z.object({ accountId: z.string().trim().min(1).max(255), enabled: z.boolean() }).strict(),
  z.object({ accountId: z.string().trim().min(1).max(255), alias: accountAliasSchema }).strict(),
  z.object({ accountId: z.string().trim().min(1).max(255), default: z.literal(true) }).strict(),
])

/** Composio refuses an alias another of the person's accounts on that toolkit already has. */
export function isDuplicateAliasError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const { status, message } = error as { status?: unknown; message?: unknown }
  return status === 409 || (typeof message === 'string' && /alias/i.test(message) && /(unique|already|exist|duplicate|taken|conflict)/i.test(message))
}

/** Complete the person's explicit disconnect before forgetting local metadata.
 * No HTTP-status-based fallback may choose another destructive operation. */
export async function disconnectAndForgetAccount(deps: {
  disconnect: () => Promise<unknown>
  forget: () => Promise<unknown>
}) {
  await deps.disconnect()
  await deps.forget()
}
