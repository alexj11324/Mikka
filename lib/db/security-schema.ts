import { pgTable, text, uuid, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import type { AuditCategory } from '@/lib/audit/actions'

/**
 * Workspace audit log (设置 › 工作区 › 审计日志). Written by recordAuditEvent()
 * in lib/audit/store.ts; reads keep 90 days and the daily audit cleanup cron
 * deletes older rows.
 */
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspaceId').notNull(),
  actorId: text('actorId'),
  action: text('action').notNull(),
  category: text('category').$type<AuditCategory>().notNull(),
  target: text('target'),
  metadata: jsonb('metadata').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  ip: text('ip'),
  userAgent: text('userAgent'),
  country: text('country'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('audit_events_workspace_idx').on(table.workspaceId, table.createdAt.desc(), table.id.desc()),
  index('audit_events_category_idx').on(table.workspaceId, table.category, table.createdAt.desc()),
  index('audit_events_created_idx').on(table.createdAt),
])
