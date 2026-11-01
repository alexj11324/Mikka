import { isToolkitSlug, pickDefaultAccountId, type ComposioAccountRecord } from '@/lib/composio-accounts'

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
  readEmail: (toolkit: string, accountId: string) => Promise<string | null>
  saveEmail: (toolkit: string, accountId: string, email: string | null) => Promise<void>
  rename: (accountId: string, alias: string) => Promise<void>
  /** A try without a final answer, kept for the cooldown. */
  noteAttempt: (toolkit: string, accountId: string) => Promise<void>
}

export type ComposioConnectDeps = ComposioEmailDeps & {
  /** Disconnects the old account and forgets Mikka's notes on it. */
  retire: (accountId: string, alias?: string | null) => Promise<void>
  chooseDefault: (toolkit: string, accountId: string) => Promise<void>
  log: (step: string, error: unknown) => void
}

function appOf(account: ComposioListedAccount | undefined): string | null {
  const slug = account?.toolkit.slug
  return isToolkitSlug(slug) ? slug : null
}

/** The account the bots use for this toolkit now, chosen or not. */
function effectiveDefault(items: ComposioListedAccount[], records: ComposioAccountRecord[], toolkit: string) {
  const own = items.filter(item => item.toolkit.slug === toolkit)
  const chosen = records.find(record => record.isDefault && (record.toolkit === toolkit || own.some(item => item.id === record.accountId)))?.accountId
  return pickDefaultAccountId(own, chosen)
}

/**
 * What a reconnect carries from the old account to the new one: a name the
 * person gave it (not the email Mikka filled in), and whether the bots used it.
 */
export function reconnectHandover(items: ComposioListedAccount[], records: ComposioAccountRecord[], oldId: string, addedId?: string) {
  const old = items.find(item => item.id === oldId)
  if (!old) return { alias: null, isDefault: false }
  const alias = old.alias?.trim() || null
  const record = records.find(item => item.accountId === oldId)
  const custom = alias && alias.toLowerCase() !== record?.email?.toLowerCase() ? alias : null
  // The person's choice counts even while the old account is expired (and so
  // not usable, which is why it is being reconnected).
  return { alias: custom, isDefault: Boolean(record?.isDefault) || effectiveDefault(items.filter(item => item.id !== addedId), records, old.toolkit.slug) === oldId }
}

/** Reads, keeps and (when it has no name) names the account after its email. Never throws. */
async function fillEmail(deps: ComposioEmailDeps & { log?: ComposioConnectDeps['log'] }, account: ComposioListedAccount, toolkit: string, keepAlias: boolean) {
  let email: string | null
  try {
    email = await deps.readEmail(toolkit, account.id)
  } catch (error) {
    deps.log?.('readEmail', error)
    await deps.noteAttempt(toolkit, account.id).catch(noteError => deps.log?.('noteAttempt', noteError))
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
  if (!added || !toolkit || added.status !== 'ACTIVE' || added.isDisabled) return false
  const replaced = input.replaceId && input.replaceId !== added.id
    ? input.items.find(item => item.id === input.replaceId && item.toolkit.slug === toolkit)
    : undefined
  const handover = replaced ? reconnectHandover(input.items, input.records, replaced.id, added.id) : null
  let reconnectComplete = !input.replaceId
  if (replaced && added.status === 'ACTIVE' && !added.isDisabled) {
    let retired = false
    try {
      await deps.retire(replaced.id, replaced.alias)
      retired = true
      reconnectComplete = true
    } catch (error) {
      deps.log('retire', error)
    }
    // After the retire, which frees the old name, so Composio takes it for the new account.
    if (retired && handover?.alias) await deps.rename(added.id, handover.alias).catch(error => { reconnectComplete = false; deps.log('carryAlias', error) })
    if (retired && handover?.isDefault) await deps.chooseDefault(toolkit, added.id).catch(error => { reconnectComplete = false; deps.log('carryDefault', error) })
  }
  await fillEmail(deps, added, toolkit, Boolean(handover?.alias))
  return reconnectComplete
}

export const EMAIL_BACKFILL_LIMIT = 5
/** A lookup that got no final answer waits this long before the next try. */
export const EMAIL_RETRY_AFTER_MS = 60 * 60 * 1000

/**
 * Accounts connected before Mikka read emails: asks the provider for up to
 * `limit` working accounts that were never asked, in parallel, and keeps each
 * answer (null too, so it is asked once). An account whose provider could not
 * be reached waits about an hour (`lastAttemptAt`) before it is asked again. Returns the records with the answers.
 */
export async function backfillComposioEmails(
  input: { items: ComposioListedAccount[]; records: ComposioAccountRecord[]; limit?: number; now?: Date },
  deps: ComposioEmailDeps,
): Promise<ComposioAccountRecord[]> {
  const byId = new Map(input.records.map(record => [record.accountId, record]))
  const now = (input.now ?? new Date()).getTime()
  const pending = input.items
    .filter(item => appOf(item) && item.status === 'ACTIVE' && !item.isDisabled)
    .filter(item => {
      const record = byId.get(item.id)
      if (!record) return true
      if (record.email || record.emailChecked) return false
      return !record.lastAttemptAt || now - record.lastAttemptAt.getTime() >= EMAIL_RETRY_AFTER_MS
    })
    .slice(0, input.limit ?? EMAIL_BACKFILL_LIMIT)
  // Loading the account list may fill Mikka's local metadata, but must not
  // rename a provider account. Alias changes belong to an explicit mutation.
  const answers = await Promise.all(pending.map(async item => ({ id: item.id, ...await fillEmail(deps, item, appOf(item)!, true) })))
  const records = new Map(byId)
  for (const answer of answers) {
    const record = records.get(answer.id)
    records.set(answer.id, answer.found
      ? { ...record, accountId: answer.id, isDefault: record?.isDefault ?? false, email: answer.email, emailChecked: true, lastAttemptAt: new Date(now) }
      : { ...record, accountId: answer.id, isDefault: record?.isDefault ?? false, email: null, emailChecked: false, lastAttemptAt: new Date(now) })
  }
  return [...records.values()]
}
