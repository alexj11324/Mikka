import { pgTable, text, timestamp, uuid, varchar, primaryKey, unique, jsonb, index } from 'drizzle-orm/pg-core'

export const workspaces = pgTable('mikka_workspaces', {
  id: uuid('id').primaryKey(),
  userId: text('userId').notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  slug: varchar('slug', { length: 64 }).unique('orvilo_workspaces_slug_unique'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})

export const workspaceMembers = pgTable('mikka_workspace_members', {
  workspaceId: uuid('workspaceId').notNull(),
  userId: text('userId').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  role: text('role').$type<'admin' | 'member'>().notNull(),
  status: text('status').$type<'active' | 'suspended'>().notNull().default('active'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.workspaceId, table.userId] })])

export const workspaceInvitations = pgTable('mikka_workspace_invitations', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspaceId').notNull(),
  userId: text('userId').notNull(),
  email: text('email').notNull(),
  role: text('role').$type<'admin' | 'member'>().notNull(),
  tokenHash: text('tokenHash').notNull().unique(),
  status: text('status').$type<'pending' | 'accepted' | 'revoked'>().notNull().default('pending'),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique().on(table.workspaceId, table.email)])

/** Workspace policy, never a per-user substitute. Only workspace admins write it. */
export const agentSettings = pgTable('agent_settings', {
  workspaceId: uuid('workspaceId').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  permissions: jsonb('permissions').$type<import('@mikka/protocol/agent-policy').StoredPermissions>().notNull().default({}),
  updatedBy: text('updatedBy').notNull(), updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/** Exact owner/workspace/session-bound approvals; never screen bytes or credentials. */
export const computerRequests = pgTable('computer_requests', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(), sessionId: uuid('sessionId').notNull(),
  workspaceId: uuid('workspaceId').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  target: text('target').notNull(), operation: jsonb('operation').$type<import('@/lib/cua/operation').ComputerOperation>().notNull(),
  status: text('status').notNull().default('pending'), expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('computer_requests_owner_session_idx').on(table.userId, table.sessionId)])
