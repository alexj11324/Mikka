import { COMPOSIO_APP_IDS, pickDefaultAccountId, type ComposioAccountRecord, type ComposioAppId } from '@/lib/composio-accounts'

// What happens around a Composio account after the provider hands it back:
// a reconnect passes the old account's name and default to the new one, and
// the account's email is read from the provider. Kept free of the SDK and the
// database (both come in as `deps`) so it can be tested on its own.

export type ComposioListedAccount = {
  id: string
  status: string
  isDisabled: boolean
  alias?: string | null
  createdAt: string
  toolkit: { slug: string }
}

export type ComposioEmailDeps = {
  /** The provider's email, null when it gives none; throws when it could not be asked (retry later). */
  readEmail: (toolkit: ComposioAppId, accountId: string) => Promise<string | null>
  saveEmail: (toolkit: ComposioAppId, accountId: string, email: string | null) => Promise<void>
  rename: (accountId: string, alias: string) => Promise<void>
}

export type ComposioConnectDeps = ComposioEmailDeps & {
  /** Disconnects the old account and forgets Mikka's notes on it (clears its alias first). */
  retire: (accountId: string) => Promise<void>
  chooseDefault: (toolkit: ComposioAppId, accountId: string) => Promise<void>
  log: (step: string, error: unknown) => void
}

function appOf(account: ComposioListedAccount | undefined): ComposioAppId | null {
  const slug = account?.toolkit.slug
  return slug && (COMPOSIO_APP_IDS as readonly string[]).includes(slug) ? slug as ComposioAppId : null
}

/** The account the bots use for this toolkit now, chosen or not. */
function effectiveDefault(items: ComposioListedAccount[], records: ComposioAccountRecord[], toolkit: string) {
  const own = items.filter(item => item.toolkit.slug === toolkit)
  const chosen = records.find(record => record.isDefault && own.some(item => item.id === record.accountId))?.accountId
  return pickDefaultAccountId(own, chosen)
}

/**
 * What a reconnect carries from the old account to the new one: a name the
 * person gave it (not the email Mikka filled in), and whether the bots used it.
 */
export function reconnectHandover(items: ComposioListedAccount[], records: ComposioAccountRecord[], oldId: string) {
  const old = items.find(item => item.id === oldId)
  if (!old) return { alias: null, isDefault: false }
  const alias = old.alias?.trim() || null
  const email = records.find(record => record.accountId === oldId)?.email ?? null
  const custom = alias && alias.toLowerCase() !== email?.toLowerCase() ? alias : null
  return { alias: custom, isDefault: effectiveDefault(items, records, old.toolkit.slug) === oldId }
}

/** Reads, keeps and (when it has no name) names the account after its email. Never throws. */
async function fillEmail(deps: ComposioEmailDeps & { log?: ComposioConnectDeps['log'] }, account: ComposioListedAccount, toolkit: ComposioAppId, keepAlias: boolean) {
  let email: string | null
  try {
    email = await deps.readEmail(toolkit, account.id)
  } catch (error) {
    deps.log?.('readEmail', error)
    return { found: false as const }
  }
  try {
    await deps.saveEmail(toolkit, account.id, email)
  } catch (error) {
    deps.log?.('saveEmail', error)
  }
  if (email && !keepAlias && !account.alias?.trim()) await deps.rename(account.id, email).catch(error => deps.log?.('renameToEmail', error))
  return { found: true as const, email }
}

/**
 * After the callback completed `addedId`. When the flow was a reconnect of
 * `replaceId` (the person's own account on the same toolkit), the old one is
 * retired and its name and default move to the new one. The email is read on
 * its own, so a failed retire does not skip it. Each step logs and goes on.
 */
export async function followUpComposioConnect(
  input: { items: ComposioListedAccount[]; records: ComposioAccountRecord[]; addedId: string; replaceId?: string | null },
  deps: ComposioConnectDeps,
) {
  const added = input.items.find(item => item.id === input.addedId)
  const toolkit = appOf(added)
  if (!added || !toolkit) return
  const replaced = input.replaceId && input.replaceId !== added.id
    ? input.items.find(item => item.id === input.replaceId && item.toolkit.slug === toolkit)
    : undefined
  const handover = replaced ? reconnectHandover(input.items, input.records, replaced.id) : null
  if (replaced) {
    try {
      await deps.retire(replaced.id)
    } catch (error) {
      deps.log('retire', error)
    }
    // After the retire, which frees the old name, so Composio takes it for the new account.
    if (handover?.alias) await deps.rename(added.id, handover.alias).catch(error => deps.log('carryAlias', error))
    if (handover?.isDefault) await deps.chooseDefault(toolkit, added.id).catch(error => deps.log('carryDefault', error))
  }
  await fillEmail(deps, added, toolkit, Boolean(handover?.alias))
}

export const EMAIL_BACKFILL_LIMIT = 5

/**
 * Accounts connected before Mikka read emails: asks the provider for up to
 * `limit` working accounts that were never asked, in parallel, and keeps each
 * answer (null too, so it is asked once). An account whose provider could not
 * be reached is left for the next load. Returns the records with the answers.
 */
export async function backfillComposioEmails(
  input: { items: ComposioListedAccount[]; records: ComposioAccountRecord[]; limit?: number },
  deps: ComposioEmailDeps,
): Promise<ComposioAccountRecord[]> {
  const byId = new Map(input.records.map(record => [record.accountId, record]))
  const pending = input.items
    .filter(item => appOf(item) && item.status === 'ACTIVE' && !item.isDisabled)
    .filter(item => { const record = byId.get(item.id); return !record || (!record.email && !record.emailChecked) })
    .slice(0, input.limit ?? EMAIL_BACKFILL_LIMIT)
  const answers = await Promise.all(pending.map(async item => ({ id: item.id, ...await fillEmail(deps, item, appOf(item)!, false) })))
  const records = new Map(byId)
  for (const answer of answers) {
    if (!answer.found) continue
    const record = records.get(answer.id)
    records.set(answer.id, { accountId: answer.id, isDefault: record?.isDefault ?? false, email: answer.email, emailChecked: true })
  }
  return [...records.values()]
}
