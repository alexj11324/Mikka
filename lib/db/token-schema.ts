// Settings › 个人访问令牌. Mirrors drizzle/20261030113800_personal_access_tokens.sql (MIKKA_DATABASE_URL).
import { sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './schema'

export const personalAccessTokens = pgTable('personal_access_tokens', {
  id: uuid('id').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** mikka_workspaces.id in the workspace database; no FK across databases. */
  workspaceId: uuid('workspaceId').notNull(),
  name: text('name').notNull(),
  /** sha256 hex of the token. The plaintext is never stored. */
  tokenHash: text('tokenHash').notNull(),
  /** Last 4 characters, for telling tokens apart. */
  hint: text('hint').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }),
  lastUsedAt: timestamp('lastUsedAt', { withTimezone: true }),
  revokedAt: timestamp('revokedAt', { withTimezone: true }),
}, table => [
  uniqueIndex('personal_access_tokens_hash_key').on(table.tokenHash),
  index('personal_access_tokens_owner_idx').on(table.userId, table.workspaceId, table.createdAt.desc()).where(sql`${table.revokedAt} is null`),
])
