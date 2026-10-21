// Workspace members and invitations (ORV-12). The desktop reaches these over
// HTTP with the same short-lived JWT it gives zero-cache, because Better Auth's
// organization plugin — which owns invitations, the role rules and the email —
// answers to a session, not to a JWT. `apps/server/src/routes/members.ts` is
// the only implementation; this file is the contract both sides share.
//
// Members themselves are read through Zero (`queries.workspaces.members`);
// only invitations need a route, because the `invitation` table is never
// synced to clients (packages/zero-schema/drizzle-zero.config.ts).
import { z } from "zod"

/**
 * The four workspace roles. Mirrors `WORKSPACE_ROLES` in
 * `packages/db/src/schema/tenancy.ts` (which cannot be imported here: db
 * depends on protocol, not the other way round). A unit test in apps/server
 * asserts the two lists are equal, so a role added on one side fails loudly
 * instead of silently.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "guest"] as const
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

export const workspaceRole = z.enum(WORKSPACE_ROLES)

/** Roles a caller may hand out. A workspace has exactly one owner (ADR 0006). */
export const INVITABLE_ROLES = ["admin", "member", "guest"] as const
export type InvitableRole = (typeof INVITABLE_ROLES)[number]

export const invitableRole = z.enum(INVITABLE_ROLES)

/**
 * A pending invitation as the members page shows it. `status` is always
 * `pending` here: the plugin marks a row accepted, rejected or canceled, and
 * those are history, not a list.
 */
export const pendingInvitation = z.object({
  id: z.uuid(),
  email: z.string(),
  role: workspaceRole.nullable(),
  teamId: z.uuid().nullable(),
  /**
   * The team's name, joined in by the read, so a pending row can say where
   * the person is going without the page having to look the id up.
   */
  teamName: z.string().nullable(),
  expiresAt: z.string(),
  inviterName: z.string().nullable(),
})
export type PendingInvitation = z.infer<typeof pendingInvitation>

export const invitationList = z.object({
  invitations: z.array(pendingInvitation),
})

/** One invitation addressed to the caller, for the "join a workspace" prompt. */
export const myInvitation = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  workspaceName: z.string(),
  role: workspaceRole.nullable(),
  expiresAt: z.string(),
})
export type MyInvitation = z.infer<typeof myInvitation>

export const myInvitationList = z.object({
  invitations: z.array(myInvitation),
})

/** What the members page sends to invite someone. */
export const inviteMemberRequest = z.object({
  email: z.email(),
  role: invitableRole,
  /** Invite straight into a team; null leaves them workspace-wide only. */
  teamId: z.uuid().nullable().optional(),
})
export type InviteMemberRequest = z.infer<typeof inviteMemberRequest>

export const updateMemberRoleRequest = z.object({
  role: workspaceRole,
})
export type UpdateMemberRoleRequest = z.infer<typeof updateMemberRoleRequest>

/**
 * `POST` answers with the invitation row the plugin wrote, and whether this
 * attempt's mail actually left the server. Both the first invitation and a
 * resend answer this shape — one parser on the page, one contract on the
 * route. A deployment with no `SMTP_URL`, or a relay that refused the
 * message, still writes the invitation — a supported setup — so the page must
 * not promise a mail that was never sent.
 */
export const invitationCreated = z.object({
  invitation: pendingInvitation,
  mailSent: z.boolean(),
})

/**
 * Why a member write was refused, as the page explains it. The plugin's own
 * codes are mapped to these in `apps/server/src/routes/members.ts`; anything
 * unmapped arrives as `rejected`.
 */
export const MEMBER_FAILURES = [
  "forbidden",
  "not_a_member",
  "already_member",
  "already_invited",
  "last_owner",
  "owner_immutable",
  "not_found",
  "expired",
  "wrong_account",
  "invalid_email",
  "rejected",
] as const
export type MemberFailure = (typeof MEMBER_FAILURES)[number]

export const memberFailure = z.object({
  error: z.enum(MEMBER_FAILURES),
  message: z.string(),
})

/**
 * Member and invitation routes. `:workspaceId` is the tenant, `:id` is the
 * member row or the invitation. Every one needs a person's JWT: an agent
 * token is refused, because agents do not administer workspaces.
 */
export const MEMBER_ROUTES = {
  /** Pending invitations of one workspace (owners and admins). */
  invitations: (workspaceId: string) =>
    `/v1/workspaces/${workspaceId}/invitations`,
  invitationResend: (workspaceId: string, id: string) =>
    `/v1/workspaces/${workspaceId}/invitations/${id}/resend`,
  invitation: (workspaceId: string, id: string) =>
    `/v1/workspaces/${workspaceId}/invitations/${id}`,
  member: (workspaceId: string, memberId: string) =>
    `/v1/workspaces/${workspaceId}/members/${memberId}`,
  /**
   * Where the invitation mail points. Not under /v1: it is a page a person
   * opens in a browser, and the server answers it with a redirect into the
   * desktop app rather than with JSON.
   */
  landing: (id: string) => `/invitations/${id}`,
  /** The caller's own pending invitations, whatever workspace they are for. */
  mine: "/v1/invitations/mine",
  accept: (id: string) => `/v1/invitations/${id}/accept`,
  reject: (id: string) => `/v1/invitations/${id}/reject`,
} as const

/**
 * Where the version gate and the rate limit are applied, so a new route under
 * either tree cannot miss them.
 */
export const MEMBER_ROUTE_PREFIXES = [
  "/v1/workspaces/*",
  "/v1/invitations/*",
] as const

/** Route patterns as Hono registers them. */
export const MEMBER_ROUTE_PATTERNS = {
  invitations: "/v1/workspaces/:workspaceId/invitations",
  invitationResend: "/v1/workspaces/:workspaceId/invitations/:id/resend",
  invitation: "/v1/workspaces/:workspaceId/invitations/:id",
  member: "/v1/workspaces/:workspaceId/members/:memberId",
  mine: "/v1/invitations/mine",
  accept: "/v1/invitations/:id/accept",
  reject: "/v1/invitations/:id/reject",
} as const
