import { index, pgTable, primaryKey, smallint, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { TaskLabelColor } from '@mikka/protocol/task-labels'
import { issues } from '@/lib/db/schema'

export const workspaceIssueLabels = pgTable('workspace_issue_labels', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  name: text('name').notNull(),
  color: text('color').$type<TaskLabelColor>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('workspace_issue_labels_workspace_id_id_key').on(table.workspaceId, table.id),
  uniqueIndex('workspace_issue_labels_name_key').on(table.workspaceId, sql`lower(${table.name})`)])

export const issueLabelRefs = pgTable('issue_label_refs', {
  issueId: uuid('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull(),
  labelId: uuid('label_id').notNull(),
  position: smallint('position').notNull(),
}, table => [primaryKey({ columns: [table.issueId, table.labelId] }), index('issue_label_refs_label_idx').on(table.workspaceId, table.labelId, table.issueId)])
