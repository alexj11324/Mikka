import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core'
import { workspaces } from './workspace-schema'
import type { GovernancePlan } from './team-entitlements-schema'
import type { AuditExportRecord } from '@/lib/audit/integrity'
import type { OrganizationAuditManifest } from '@/lib/governance/audit-export'
export { workspaceEntitlements, governanceApprovalTemplates } from './team-entitlements-schema'
export type { GovernancePlan, ApprovalTemplateRules } from './team-entitlements-schema'

export type OrganizationRole = 'owner' | 'admin' | 'member'

export const organizations = pgTable('mikka_organizations', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  createdBy: text('createdBy').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archivedAt', { withTimezone: true }),
})

/** Organization membership is administrative only. It never grants workspace ACL. */
export const organizationMembers = pgTable('mikka_organization_members', {
  organizationId: uuid('organizationId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull(),
  role: text('role').$type<OrganizationRole>().notNull(),
  status: text('status').$type<'active' | 'suspended'>().notNull().default('active'),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.organizationId, table.userId] }), index('mikka_org_members_user_idx').on(table.userId)])

/** A pending invitation grants only Organization Member; no Workspace or Project ACL. */
export const organizationInvitations = pgTable('mikka_organization_invitations', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organizationId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  createdBy: text('createdBy').notNull(),
  email: text('email').notNull(),
  tokenHash: text('tokenHash').notNull().unique(),
  status: text('status').$type<'pending' | 'accepted' | 'revoked'>().notNull().default('pending'),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  acceptedBy: text('acceptedBy'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('mikka_org_invitation_email_unique').on(table.organizationId, table.email),
  index('mikka_org_invitation_org_idx').on(table.organizationId, table.createdAt),
])

export const organizationWorkspaces = pgTable('mikka_organization_workspaces', {
  workspaceId: uuid('workspaceId').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  organizationId: uuid('organizationId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('mikka_org_workspaces_org_idx').on(table.organizationId)])

/** Written only by trusted provisioning; no workspace or organization API can buy itself a plan. */
export const organizationEntitlements = pgTable('mikka_organization_entitlements', {
  organizationId: uuid('organizationId').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
  plan: text('plan').$type<GovernancePlan>().notNull().default('free'),
  source: text('source').$type<'cloud' | 'license'>().notNull().default('cloud'),
  seatLimit: integer('seatLimit'),
  expiresAt: timestamp('expiresAt', { withTimezone: true }),
  billingPlan: text('billingPlan').$type<GovernancePlan>().notNull().default('free'),
  billingExpiresAt: timestamp('billingExpiresAt', { withTimezone: true }),
  billingRevision: bigint('billingRevision', { mode: 'number' }).notNull().default(0),
  billingSubscriptionId: text('billingSubscriptionId'),
  billingWorkspaceId: uuid('billingWorkspaceId'),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/** An organization designates an existing account; no balances change owners. */
export const organizationBillingAccounts = pgTable('mikka_organization_billing_accounts', {
  organizationId: uuid('organizationId').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspaceId').notNull().unique().references(() => workspaces.id),
  createdBy: text('createdBy').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/** Same-transaction, append-only organization audit. No workspace access is implied by viewing it. */
export const organizationAuditEvents = pgTable('mikka_organization_audit_events', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organizationId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  actorId: text('actorId').notNull(),
  action: text('action').notNull(),
  result: text('result').$type<'success' | 'denied' | 'failure'>().notNull().default('success'),
  correlationId: uuid('correlationId').notNull(),
  targetId: text('targetId'),
  metadata: jsonb('metadata').$type<Record<string, string | number | boolean | null>>().notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('mikka_org_audit_org_created_idx').on(table.organizationId, table.createdAt)])

export const organizationAuditExports = pgTable('mikka_organization_audit_exports', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organizationId').notNull().references(() => organizations.id),
  createdBy: text('createdBy').notNull(),
  manifest: jsonb('manifest').$type<OrganizationAuditManifest>().notNull(),
  records: jsonb('records').$type<AuditExportRecord[]>().notNull(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('mikka_org_audit_exports_org_expiry_idx').on(table.organizationId, table.expiresAt)])

/** Revocation side effects are retried after the workspace transaction commits. */
export const governanceMemberOutbox = pgTable('mikka_governance_member_outbox', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspaceId').notNull(),
  userId: text('userId').notNull(),
  operation: text('operation').$type<'suspend' | 'restore'>().notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('deliveredAt', { withTimezone: true }),
}, table => [index('mikka_governance_member_outbox_pending_idx').on(table.deliveredAt, table.createdAt)])

export type SharingRule = 'allow' | 'approval_required' | 'deny'
export const organizationResourcePolicies = pgTable('mikka_organization_resource_policies', {
  organizationId: uuid('organizationId').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
  modelCredentialSharing: text('modelCredentialSharing').$type<SharingRule>().notNull().default('allow'),
  mcpSharing: text('mcpSharing').$type<SharingRule>().notNull().default('allow'),
  allowedModelProviders: jsonb('allowedModelProviders').$type<string[] | null>(),
  auditRetentionDays: integer('auditRetentionDays'),
  legalHold: boolean('legalHold').notNull().default(false),
  revision: integer('revision').notNull().default(1),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export type SharedResourceKind = 'subscription' | 'api_key' | 'mcp' | 'skill'
export const organizationResourceApprovals = pgTable('mikka_organization_resource_approvals', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organizationId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspaceId').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<SharedResourceKind>().notNull(),
  resourceId: text('resourceId').notNull(),
  ownerId: text('ownerId').notNull(),
  status: text('status').$type<'pending' | 'approved' | 'denied'>().notNull().default('pending'),
  decidedBy: text('decidedBy'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('mikka_resource_approval_resource_unique').on(table.organizationId, table.workspaceId, table.kind, table.resourceId, table.ownerId)])

export const organizationPolicyOutbox = pgTable('mikka_organization_policy_outbox', {
  id: uuid('id').primaryKey(),
  organizationId: uuid('organizationId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  workspaceIds: jsonb('workspaceIds').$type<string[]>().notNull(),
  changes: jsonb('changes').$type<{ modelCredentials: boolean; mcp: boolean; modelProviders: boolean }>().notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('deliveredAt', { withTimezone: true }),
})
