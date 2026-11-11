/**
 * The membership rules ALE-29 adds to a task: who may invite and mute, and what
 * a member row means.
 *
 * Nothing here imports: these are the decisions themselves, tested in
 * issue-member-role.test.ts. The actions in app/actions/collaboration.ts call
 * them and hold the database transaction.
 */

export type IssueMemberRole = 'owner' | 'member'

/** The facts the rules need about the caller and the task. */
export type MembershipCaller = {
  /** The signed-in account. */
  accountId: string
  /** The task's owner, who is a member without a row. */
  ownerId: string
  /** The caller's row, when they have one. */
  role: IssueMemberRole | null
}

/**
 * May this caller invite members and change the task's visibility? The task's
 * owner always may, and so may a member carrying the owner role. Ownership is
 * the task's, so this never widens to the workspace.
 */
export function mayManageMembers(caller: MembershipCaller): boolean {
  return caller.accountId === caller.ownerId || caller.role === 'owner'
}

/**
 * May this caller hand out the owner role? Only the task's own owner: a member
 * who was given the role can invite, but cannot make more of themselves.
 */
export function mayGrantOwnerRole(caller: MembershipCaller): boolean {
  return caller.accountId === caller.ownerId
}

/**
 * May this caller mute or unmute the given member? A member controls their own
 * subscription, and only the task's owner controls somebody else's.
 */
export function maySetSubscription(caller: MembershipCaller, memberId: string): boolean {
  return memberId === caller.accountId || caller.accountId === caller.ownerId
}

/**
 * May the owner's own subscription be changed? No: the owner has no member row,
 * so muting them would leave the one account that cannot re-add itself without
 * notifications.
 */
export function mayMuteMember(memberId: string, ownerId: string): boolean {
  return memberId !== ownerId
}
