/**
 * Who can read a resource, from the same `resource_access_policies` chain
 * `mikka_resource_acl_allowed` walks. A relation edit changes that chain, and a
 * changed audience is what the confirmAccess handshake asks about before it is
 * written.
 *
 * Nothing here imports: these are the audience rules themselves, and they are
 * tested without a database in audience.test.ts.
 */

/** One link of the chain, as `resource_access_policies` and `resource_access_grants` store it. */
export type AccessLink = {
  kind: string
  id: string
  ownerId: string | null
  visibility: 'shared' | 'private' | 'quarantined'
  /** Accounts granted `canReadContent` on this link. */
  grants: readonly string[]
}

/**
 * The accounts that may read a resource whose ancestor chain is `chain`. A
 * reader must satisfy every link: the link's owner and its `canReadContent`
 * grantees always do, and a `shared` link also admits every active member of
 * the tenant. One `quarantined` link admits nobody, and a resource with no
 * chain at all has no readers.
 *
 * Membership is an input because the caller has already proved the tenant; a
 * shared link's "everyone" is exactly that tenant's active members.
 */
export function readableAccounts(chain: readonly AccessLink[], members: readonly string[]): Set<string> {
  // Each link admits a bounded set, so their intersection lives inside the union.
  const universe = new Set<string>(members)
  for (const link of chain) {
    if (link.ownerId) universe.add(link.ownerId)
    for (const account of link.grants) universe.add(account)
  }
  const memberSet = new Set(members)
  const readable = new Set<string>()
  for (const account of universe) {
    if (chain.length && chain.every(link => link.visibility !== 'quarantined'
      && (link.ownerId === account || link.grants.includes(account) || link.visibility === 'shared' && memberSet.has(account)))) readable.add(account)
  }
  return readable
}

export type AudienceChange = {
  changed: boolean
  /** True when at least one account that could read before no longer can. */
  narrowed: boolean
  /** Accounts that gain read access. */
  added: readonly string[]
  /** Accounts that lose read access. */
  removed: readonly string[]
}

/**
 * The chain a task would have once it hangs under `parent`, or under nothing.
 * `chain[0]` is the task itself; replacing its ancestors keeps the task's own
 * policy (owner, visibility, grants) and swaps only the ancestry above it.
 */
export function rechain(chain: readonly AccessLink[], parent: readonly AccessLink[] | null): AccessLink[] {
  if (!chain.length) return []
  return [chain[0], ...(parent ?? [])]
}

/** How the readable set differs between two chains; `members` is the same list for both. */
export function audienceChange(before: readonly AccessLink[], after: readonly AccessLink[], members: readonly string[]): AudienceChange {
  const wasReadable = readableAccounts(before, members)
  const willRead = readableAccounts(after, members)
  const added = [...willRead].filter(account => !wasReadable.has(account)).sort()
  const removed = [...wasReadable].filter(account => !willRead.has(account)).sort()
  return { changed: added.length > 0 || removed.length > 0, narrowed: removed.length > 0, added, removed }
}
