// Settings › 审计日志. Kept out of schema.ts while #431 is open; insert/select
// work without registering the table in the relational `schema` object.
import { index, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { AuditActorType, AuditCategory } from '@/lib/audit/events'

export const workspaceAuditEvents = pgTable('workspace_audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspaceId').notNull(),
  actorType: text('actorType').$type<AuditActorType>().notNull(),
  actorId: text('actorId'),
  actorName: text('actorName').notNull(),
  action: text('action').notNull(),
  category: text('category').$type<AuditCategory>().notNull(),
  targetType: text('targetType'),
  targetId: text('targetId'),
  targetLabel: text('targetLabel'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ip: inet('ip'),
  geoCity: text('geoCity'),
  geoCountry: text('geoCountry'),
  geoRegion: text('geoRegion'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('workspace_audit_events_ws_created_idx').on(table.workspaceId, table.createdAt.desc(), table.id.desc()),
  index('workspace_audit_events_ws_category_created_idx').on(table.workspaceId, table.category, table.createdAt.desc(), table.id.desc()),
])

export type WorkspaceAuditEventRow = typeof workspaceAuditEvents.$inferSelect
