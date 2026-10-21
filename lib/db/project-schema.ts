import { pgTable, uuid, text, varchar, jsonb, integer, timestamp } from 'drizzle-orm/pg-core'
import type { ProjectDraft } from '@/lib/project-input'

export const projects = pgTable('workspace_projects', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(), name: varchar('name', { length: 200 }).notNull(), summary: varchar('summary', { length: 500 }).notNull(), description: text('description').notNull(), status: text('status').notNull(), priority: text('priority').notNull(), lead: text('lead').notNull(), team: varchar('team', { length: 100 }).notNull(), startDate: varchar('startDate', { length: 10 }).notNull(), targetDate: varchar('targetDate', { length: 10 }).notNull(), properties: jsonb('properties').$type<ProjectDraft['properties']>().notNull().default({ color: 'green', members: [], labels: [], dependencyIds: [], milestones: [] }), issueIds: jsonb('issueIds').$type<string[]>().notNull(), revision: integer('revision').notNull(), createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})
export const projectEvents = pgTable('workspace_project_events', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(), projectId: uuid('projectId').notNull(), message: text('message').notNull(), createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})
