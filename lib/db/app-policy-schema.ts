// Settings › 团队权限 › 允许使用的应用. Mirrors drizzle/20261030204829_workspace_app_policies.sql.
import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const workspaceAppPolicies = pgTable('workspace_app_policies', {
  workspaceId: uuid('workspaceId').notNull(),
  /** A Composio toolkit slug (lib/app-policy/apps.ts). */
  app: text('app').notNull(),
  access: text('access').$type<'allow' | 'deny'>().notNull(),
  updatedBy: text('updatedBy').notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.workspaceId, table.app] })])
