import { pgTable, text, uuid, varchar, jsonb, integer, timestamp, primaryKey } from 'drizzle-orm/pg-core'
import type { JSONContent } from '@tiptap/react'

export const users = pgTable('user', {
  id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull(), image: text('image'),
})
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(), name: text('name').notNull(), harness: text('harness').notNull(),
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
export const issueVersions = pgTable('issue_versions', {
  id: uuid('id').primaryKey(), issueId: uuid('issueId').notNull(), userId: text('userId').notNull(),
  revision: integer('revision').notNull(), title: varchar('title', { length: 200 }).notNull(),
  content: jsonb('content').$type<JSONContent>().notNull(), status: text('status').notNull(), priority: text('priority').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})
