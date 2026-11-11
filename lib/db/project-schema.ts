import { pgTable, uuid, text, varchar, jsonb, integer, timestamp, index, unique, primaryKey, foreignKey } from 'drizzle-orm/pg-core'
import type { ProjectDraft } from '@/lib/project-input'
import { workspaces } from './workspace-schema.ts'

export const projects = pgTable('workspace_projects', {
  id: uuid('id').primaryKey(),
  /** NULL is a quarantined legacy row, never an accessible personal project. */
  workspaceId: uuid('workspaceId').references(() => workspaces.id),
  /** Stable creator identity; retained under the old column name for compatibility. */
  userId: text('userId').notNull(),
  leadUserId: text('leadUserId'),
  archivedAt: timestamp('archivedAt', { withTimezone: true }),
  archivedBy: text('archivedBy'),
  name: varchar('name', { length: 200 }).notNull(), summary: varchar('summary', { length: 500 }).notNull(), description: text('description').notNull(), status: text('status').notNull(), priority: text('priority').notNull(), lead: text('lead').notNull(), team: varchar('team', { length: 100 }).notNull(), startDate: varchar('startDate', { length: 10 }).notNull(), targetDate: varchar('targetDate', { length: 10 }).notNull(), properties: jsonb('properties').$type<ProjectDraft['properties']>().notNull().default({ color: 'green', members: [], labels: [], dependencyIds: [], milestones: [] }),
  /** Migration input only. Public reads hydrate this compatibility field from projectTasks. */
  issueIds: jsonb('issueIds').$type<string[]>().notNull(), revision: integer('revision').notNull(), createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('workspace_projects_owner_idx').on(table.userId), index('workspace_projects_workspace_idx').on(table.workspaceId), unique('workspace_projects_id_workspace_unique').on(table.id, table.workspaceId)])

/** The only authoritative Project → Task relationship. Tasks live in the app DB. */
export const projectTasks = pgTable('workspace_project_tasks', {
  issueId: uuid('issueId').primaryKey(),
  projectId: uuid('projectId').notNull(),
  workspaceId: uuid('workspaceId').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('workspace_project_tasks_project_idx').on(table.projectId, table.issueId),
  index('workspace_project_tasks_workspace_idx').on(table.workspaceId),
  foreignKey({ name: 'workspace_project_tasks_project_fk', columns: [table.projectId, table.workspaceId], foreignColumns: [projects.id, projects.workspaceId] }).onDelete('cascade'),
])

/** Project membership is collaboration metadata; Workspace membership remains the ACL. */
export const projectMembers = pgTable('workspace_project_members', {
  projectId: uuid('projectId').notNull(),
  workspaceId: uuid('workspaceId').notNull(),
  userId: text('userId').notNull(),
  role: text('role').$type<'member'>().notNull().default('member'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.projectId, table.userId] }),
  index('workspace_project_members_workspace_user_idx').on(table.workspaceId, table.userId),
  foreignKey({ name: 'workspace_project_members_project_fk', columns: [table.projectId, table.workspaceId], foreignColumns: [projects.id, projects.workspaceId] }).onDelete('cascade'),
])
export const projectEvents = pgTable('workspace_project_events', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(), projectId: uuid('projectId').notNull(), message: text('message').notNull(), createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('workspace_project_events_project_created_idx').on(table.projectId, table.userId, table.createdAt.desc())])
