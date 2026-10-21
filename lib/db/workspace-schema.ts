import { pgTable, text, timestamp, uuid, varchar, primaryKey, unique } from 'drizzle-orm/pg-core'

export const workspaces = pgTable('mikka_workspaces', {
  id: uuid('id').primaryKey(),
  userId: text('userId').notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
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
