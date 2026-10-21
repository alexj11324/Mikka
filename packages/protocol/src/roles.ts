// The permission matrix of ADR 0047: what each workspace role may do, and the
// one row-level rule that narrows it (team visibility). It lives in
// packages/protocol because three layers need the same answer and none of them
// may depend on another: the synced queries and mutators in packages/zero-schema,
// the server-side filters in packages/db, and the settings UI. A second copy of
// this table is how the documented matrix and the enforced one drift apart.

/** Every workspace role, most powerful first. */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "guest"] as const
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

/**
 * What a role may do in its workspace. `read` is the workspace-wide read that
 * team visibility then narrows row by row; everything else is a capability the
 * role either has or does not.
 */
export const WORKSPACE_CAPABILITIES = [
  /** Read the workspace's issues, projects and documents. */
  "read",
  /** Create and edit issues, projects, cycles, comments and criteria. */
  "write",
  /** Change workspace settings: agent policy, guidance, member roles. */
  "administer",
  /** Create a team, set its visibility, change who is on it. */
  "manageTeams",
  /** Share an issue or a project with a guest. */
  "share",
  /** Send a message to, or stop, a running agent. */
  "steer",
] as const
export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number]

/**
 * One row per role. The predicates below are derived from it, so the matrix
 * ADR 0047 documents and the one enforced here cannot drift apart. A role
 * missing from the table (an unknown string from the database) has no
 * capability at all: every check fails closed.
 */
export const ROLE_CAPABILITIES: Record<
  WorkspaceRole,
  readonly WorkspaceCapability[]
> = {
  owner: ["read", "write", "administer", "manageTeams", "share", "steer"],
  admin: ["read", "write", "administer", "manageTeams", "share", "steer"],
  member: ["read", "write", "share", "steer"],
  // A guest reads only the issues and projects shared with them, which the
  // row-level filters enforce; they write nothing.
  guest: ["read"],
}

export function roleMay(
  role: string,
  capability: WorkspaceCapability
): boolean {
  const capabilities = ROLE_CAPABILITIES[role as WorkspaceRole]
  return capabilities ? capabilities.includes(capability) : false
}

export function roleMayRead(role: string): boolean {
  return roleMay(role, "read")
}

export function roleMayWrite(role: string): boolean {
  return roleMay(role, "write")
}

/** Roles that change workspace settings (agent permissions, guidance). */
export function roleMayAdminister(role: string): boolean {
  return roleMay(role, "administer")
}

export function roleMayManageTeams(role: string): boolean {
  return roleMay(role, "manageTeams")
}

export function roleMayShare(role: string): boolean {
  return roleMay(role, "share")
}

export function roleMaySteer(role: string): boolean {
  return roleMay(role, "steer")
}

/**
 * Whether the role sees every team of its workspace, private ones included.
 * Owners and admins administer the workspace, so a team they cannot see is a
 * team they cannot fix (ADR 0047).
 */
export function roleSeesEveryTeam(role: string): boolean {
  return roleMayAdminister(role)
}

/**
 * The same set as a value, for callers that compare a stored role against a
 * list rather than asking about one row: the synced queries build a ZQL
 * predicate from it.
 */
export const EVERY_TEAM_ROLES: readonly WorkspaceRole[] =
  WORKSPACE_ROLES.filter(roleSeesEveryTeam)

/** A guest reads only what is shared with them (ADR 0047). */
export function roleIsGuest(role: string): boolean {
  return role === "guest"
}

/**
 * Row-level visibility (ADR 0047): a row in a private team reaches that team's
 * members and the workspace's owners and admins, and nobody else. `team` is
 * the row's team as stored, or null when the row belongs to no team at all
 * (a project with no lead team), which every member of the workspace sees.
 *
 * The synced queries express the same rule as a predicate over `ctx.userID`
 * and the server as a SQL lookup; this is the rule itself, so the matrix can
 * be reasoned about — and unit-tested — without a database.
 */
export function rowIsVisibleTo(
  team: { isPrivate: boolean } | null | undefined,
  access: { role: string; onTeam: boolean }
): boolean {
  if (!team || !team.isPrivate) return true
  return access.onTeam || roleSeesEveryTeam(access.role)
}
