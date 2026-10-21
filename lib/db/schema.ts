import { pgTable, text, uuid, varchar, jsonb, integer, timestamp, primaryKey, index } from 'drizzle-orm/pg-core'
import type { JSONContent } from '@tiptap/react'

export const users = pgTable('user', {
  id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull(), image: text('image'),
})
export const issueMembers = pgTable('issue_members', {
  issueId: uuid('issueId').notNull(), userId: text('userId').notNull(), memberId: text('memberId').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.issueId, table.memberId] })])
export const issueDocuments = pgTable('issue_documents', {
  issueId: uuid('issueId').primaryKey(), userId: text('userId').notNull(), state: text('state').notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export const issues = pgTable('issues', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  content: jsonb('content').$type<JSONContent>().notNull(),
  status: text('status').notNull(), priority: text('priority').notNull(),
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})
export const agentSessions = pgTable('agent_sessions', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(), title: varchar('title', { length: 200 }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('agent_sessions_user_updated_idx').on(table.userId, table.updatedAt.desc())])

export const agentTurns = pgTable('agent_turns', {
  id: uuid('id').primaryKey(), sessionId: uuid('sessionId').notNull(), userId: text('userId').notNull(),
  prompt: text('prompt').notNull(), completion: text('completion').notNull().default(''),
  status: text('status').$type<'pending' | 'complete' | 'failed' | 'stopped'>().notNull().default('pending'),
  error: text('error'), attemptId: uuid('attemptId').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('agent_turns_session_user_created_idx').on(table.sessionId, table.userId, table.createdAt)])

export const issueVersions = pgTable('issue_versions', {
  id: uuid('id').primaryKey(), issueId: uuid('issueId').notNull(), userId: text('userId').notNull(),
  revision: integer('revision').notNull(), title: varchar('title', { length: 200 }).notNull(),
  content: jsonb('content').$type<JSONContent>().notNull(), status: text('status').notNull(), priority: text('priority').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})
