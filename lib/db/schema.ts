import { pgTable, text, uuid, varchar, jsonb, integer, timestamp } from 'drizzle-orm/pg-core'
import type { JSONContent } from '@tiptap/react'

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
