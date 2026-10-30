// Settings › 团队权限 › 允许使用的应用. Mirrors drizzle/20261030204829_workspace_app_policies.sql.
import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { PolicyApp } from '@/lib/app-policy/apps'

export const workspaceAppPolicies = pgTable('workspace_app_policies', {
  workspaceId: uuid('workspaceId').notNull(),
  app: text('app').$type<PolicyApp>().notNull(),
  access: text('access').$type<'allow' | 'deny'>().notNull(),
  updatedBy: text('updatedBy').notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.workspaceId, table.app] })])
