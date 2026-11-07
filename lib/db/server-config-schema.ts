import { sql } from 'drizzle-orm'
import { check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { users } from './schema'

export const serverGitHubApp = pgTable('server_github_app', {
  id: integer('id').primaryKey().default(1),
  ciphertext: text('ciphertext').notNull(), iv: text('iv').notNull(), keyVersion: integer('keyVersion').notNull(),
  createdBy: text('createdBy').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [check('server_github_app_singleton', sql`${table.id} = 1`)])

export const githubAppManifestIntents = pgTable('github_app_manifest_intents', {
  stateHash: text('stateHash').primaryKey(),
  userId: text('userId').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  sessionId: text('sessionId').notNull(), origin: text('origin').notNull(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})
