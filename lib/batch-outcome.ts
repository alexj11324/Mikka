/**
 * Batch operations report one outcome per item (ALE-28). A batch that can only
 * succeed or fail as a whole makes the caller guess which part it must retry:
 * one address already in the workspace must not throw away the other nineteen.
 *
 * Nothing here imports: these are the per-item rules, tested in
 * batch-outcome.test.ts.
 */

/** What became of one item of a batch. */
export type ItemOutcome<T, R extends string> =
  | ({ item: T; used: true } & { [K in R]?: never })
  | ({ item: T; used: false; reason: R })

/**
 * Why an invitation was skipped instead of created. A pending invitation is not
 * skipped: inviting that address again is how a stale link is renewed, which is
 * what the existing upsert does and what the member list offers.
 */
export type InvitationSkip = 'alreadyMember' | 'duplicate'

export type PlannedInvitation = ItemOutcome<string, InvitationSkip>

/**
 * Split the addresses one invitation batch names into the ones to invite and the
 * ones to skip, keeping the caller's order and reporting the reason per address.
 * `members` are the workspace's current member emails, compared
 * case-insensitively as the unique index does.
 */
export function planInvitations(emails: readonly string[], members: ReadonlySet<string>): PlannedInvitation[] {
  const seen = new Set<string>()
  return emails.map(address => {
    const email = address.trim().toLowerCase()
    const skip = seen.has(email) ? 'duplicate' : members.has(email) ? 'alreadyMember' : null
    if (skip) return { item: email, used: false, reason: skip }
    seen.add(email)
    return { item: email, used: true }
  })
}

/** The items a batch should act on, in the order they were given. */
export function usedItems<T, R extends string>(outcomes: readonly ItemOutcome<T, R>[]): T[] {
  return outcomes.filter(outcome => outcome.used).map(outcome => outcome.item)
}

/** How many items a batch acted on, and a count per skip reason, for a short summary. */
export function outcomeCounts<T, R extends string>(outcomes: readonly ItemOutcome<T, R>[]): { used: number; skipped: Record<string, number> } {
  const skipped: Record<string, number> = {}
  let used = 0
  for (const outcome of outcomes) {
    if (outcome.used) used += 1
    else skipped[outcome.reason] = (skipped[outcome.reason] ?? 0) + 1
  }
  return { used, skipped }
}
