import { pgTable, text, timestamp, uuid, varchar, primaryKey, unique, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const workspaces = pgTable('mikka_workspaces', {
  id: uuid('id').primaryKey(),
  userId: text('userId').notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  slug: varchar('slug', { length: 64 }).unique('orvilo_workspaces_slug_unique'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('mikka_workspaces_owner_idx').on(table.userId)])

export const workspaceMembers = pgTable('mikka_workspace_members', {
  workspaceId: uuid('workspaceId').notNull(),
  userId: text('userId').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  role: text('role').$type<'admin' | 'member'>().notNull(),
  status: text('status').$type<'active' | 'suspended'>().notNull().default('active'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.workspaceId, table.userId] }), index('mikka_workspace_members_user_active_idx').on(table.userId).where(sql`status = 'active'`)])

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
}, table => [unique().on(table.workspaceId, table.email), index('mikka_workspace_invitations_workspace_pending_idx').on(table.workspaceId).where(sql`status = 'pending'`)])
