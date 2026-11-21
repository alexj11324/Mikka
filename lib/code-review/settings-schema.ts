import { boolean, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from '@/lib/db/schema'

/** Nullable scalar overrides; P1 is the only writer of these typed execution columns. */
export const pullRequestDefaults = pgTable('pull_request_defaults', {
  workspaceId: uuid('workspaceId').notNull(),
  userId: text('userId').references(() => users.id, { onDelete: 'cascade' }),
  titlePrefix: text('titlePrefix'), branchPrefix: text('branchPrefix'),
  autoMerge: boolean('autoMerge'), draft: boolean('draft'),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('pull_request_defaults_scope').on(table.workspaceId, table.userId).nullsNotDistinct()])

export const workspaceCodeReviewConfiguration = pgTable('workspace_code_review_configuration', {
  workspaceId: uuid('workspaceId').primaryKey(),
  model: text('model'), severity: text('severity'), ignoredPaths: text('ignoredPaths').array(), output: text('output'),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export const workspaceCodeReviewRepositories = pgTable('workspace_code_review_repositories', {
  workspaceId: uuid('workspaceId').notNull(), repository: text('repository').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  scheduleId: uuid('scheduleId'),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.workspaceId, table.repository] })])
