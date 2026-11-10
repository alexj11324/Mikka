import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { workspaces } from './workspace-schema'
import type { ApprovalMode, StoredPermissions } from '@mikka/protocol/agent-policy'

export type GovernancePlan = 'free' | 'pro' | 'enterprise'
export type ApprovalTemplateRules = { permissions?: Omit<StoredPermissions, 'computer_use'>; networkAllow?: string[]; approvalMode?: ApprovalMode }

/** Provisioned by an operator; workspace APIs cannot grant their own plan. */
export const workspaceEntitlements = pgTable('mikka_workspace_entitlements', {
  workspaceId: uuid('workspaceId').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  plan: text('plan').$type<GovernancePlan>().notNull().default('free'),
  source: text('source').$type<'cloud' | 'license'>().notNull().default('cloud'),
  seatLimit: integer('seatLimit'),
  expiresAt: timestamp('expiresAt', { withTimezone: true }),
  billingPlan: text('billingPlan').$type<GovernancePlan>().notNull().default('free'),
  billingExpiresAt: timestamp('billingExpiresAt', { withTimezone: true }),
  billingRevision: bigint('billingRevision', { mode: 'number' }).notNull().default(0),
  billingSubscriptionId: text('billingSubscriptionId'),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export const governanceApprovalTemplates = pgTable('mikka_governance_approval_templates', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspaceId').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  rules: jsonb('rules').$type<ApprovalTemplateRules>().notNull(),
  createdBy: text('createdBy').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('mikka_governance_templates_workspace_idx').on(table.workspaceId)])
