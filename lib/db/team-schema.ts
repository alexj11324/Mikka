import { pgTable, uuid, text, varchar, timestamp, boolean, primaryKey, unique, index } from 'drizzle-orm/pg-core'

export const teams = pgTable('orvilo_teams', {
  id: uuid('id').primaryKey(), workspaceId: uuid('workspaceId').notNull(), userId: text('userId').notNull(),
  name: varchar('name', { length: 100 }).notNull(), identifier: varchar('identifier', { length: 12 }).notNull(),
  description: varchar('description', { length: 500 }).notNull().default(''),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique().on(table.workspaceId, table.identifier)])
export const teamMembers = pgTable('orvilo_team_members', {
  teamId: uuid('teamId').notNull(), userId: text('userId').notNull(),
  role: text('role').$type<'owner' | 'member'>().notNull().default('member'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.teamId, table.userId] }), index('orvilo_team_members_user_idx').on(table.userId)])
export const teamIssues = pgTable('orvilo_team_issues', {
  issueId: uuid('issueId').primaryKey(), teamId: uuid('teamId').notNull(), workspaceId: uuid('workspaceId').notNull(), userId: text('userId').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('orvilo_team_issues_team_idx').on(table.teamId)])
export const teamProjects = pgTable('orvilo_team_projects', {
  projectId: uuid('projectId').notNull(), teamId: uuid('teamId').notNull(), workspaceId: uuid('workspaceId').notNull(), userId: text('userId').notNull(),
  isPrimary: boolean('isPrimary').notNull().default(false),
}, table => [primaryKey({ columns: [table.projectId, table.teamId] }), index('orvilo_team_projects_workspace_idx').on(table.workspaceId), index('orvilo_team_projects_team_idx').on(table.teamId)])
