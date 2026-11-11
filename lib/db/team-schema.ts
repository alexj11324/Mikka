import { pgTable, uuid, text, varchar, timestamp, boolean, primaryKey, unique, index, uniqueIndex, bigint, jsonb } from 'drizzle-orm/pg-core'

export const teams = pgTable('mikka_teams', {
  id: uuid('id').primaryKey(), workspaceId: uuid('workspaceId').notNull(), userId: text('userId').notNull(),
  name: varchar('name', { length: 100 }).notNull(), identifier: varchar('identifier', { length: 12 }).notNull(),
  /** The last task number given in this team; the database assigns them (assign_team_issue_number). */
  lastIssueNumber: bigint('lastIssueNumber', { mode: 'number' }).notNull().default(0),
  description: varchar('description', { length: 500 }).notNull().default(''),
  archivedAt: timestamp('archivedAt', { withTimezone: true }),
  archivedBy: text('archivedBy'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique().on(table.workspaceId, table.identifier)])
export const teamMembers = pgTable('mikka_team_members', {
  teamId: uuid('teamId').notNull(), userId: text('userId').notNull(),
  role: text('role').$type<'owner' | 'member'>().notNull().default('member'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.teamId, table.userId] })])
export const teamIssues = pgTable('mikka_team_issues', {
  issueId: uuid('issueId').primaryKey(), teamId: uuid('teamId').notNull(), workspaceId: uuid('workspaceId').notNull(), userId: text('userId').notNull(),
  /** The task's number in its team (AL-12). Writers omit it: the database assigns it on insert and on a team move. */
  number: bigint('number', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('mikka_team_issues_team_idx').on(table.teamId), uniqueIndex('mikka_team_issues_team_number_unique').on(table.teamId, table.number)])
export const teamIssueCreateReceipts = pgTable('team_issue_create_receipts', {
  requestId: uuid('requestId').primaryKey(), issueId: uuid('issueId').notNull().unique(), ownerId: text('ownerId').notNull(),
  teamId: uuid('teamId').notNull(), workspaceId: uuid('workspaceId').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})
export const teamIssuePromotionReceipts = pgTable('team_issue_promotion_receipts', {
  requestId: uuid('requestId').primaryKey(), issueId: uuid('issueId').notNull(), ownerId: text('ownerId').notNull(),
  teamId: uuid('teamId').notNull(), workspaceId: uuid('workspaceId').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})
export const teamProjects = pgTable('mikka_team_projects', {
  projectId: uuid('projectId').notNull(), teamId: uuid('teamId').notNull(), workspaceId: uuid('workspaceId').notNull(), userId: text('userId').notNull(),
  isPrimary: boolean('isPrimary').notNull().default(false),
}, table => [primaryKey({ columns: [table.projectId, table.teamId] })])

/** Kept after the team is removed; workspace deletion removes this tenant's journal. */
export const teamLifecycleEvents = pgTable('team_lifecycle_events', {
  id: uuid('id').primaryKey(), workspaceId: uuid('workspaceId').notNull(), teamId: uuid('teamId').notNull(),
  actorId: text('actorId').notNull(), action: text('action').$type<'archived' | 'restored' | 'grouping_removed' | 'deleted'>().notNull(),
  snapshot: jsonb('snapshot').$type<{
    team: { name: string; identifier: string; archivedAt: string | null; lastIssueNumber: number },
    tasks: Array<{ id: string; number: number }>, projects: Array<{ id: string; isPrimary: boolean }>,
    members: Array<{ userId: string; role: string }>, runs: number, pullRequests: number,
  }>().notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('team_lifecycle_events_workspace_team_idx').on(table.workspaceId, table.teamId, table.createdAt)])
