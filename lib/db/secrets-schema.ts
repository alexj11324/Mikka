// Settings › 密钥与环境 and BYO E2B key. Mirrors drizzle/20261030204835_workspace_secrets_env.sql (MIKKA_DATABASE_URL).
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

export const WORKSPACE_SECRET_KINDS = ['secret', 'env'] as const
export const WORKSPACE_SECRET_SCOPES = ['workspace', 'repository'] as const
export const E2B_KEY_ERROR_CODES = ['invalid', 'rate_limited', 'template_unavailable', 'unavailable'] as const

export const workspaceSecrets = pgTable('workspace_secrets', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspaceId').notNull(),
  name: text('name').notNull(),
  kind: text('kind').$type<(typeof WORKSPACE_SECRET_KINDS)[number]>().notNull(),
  scopeType: text('scopeType').$type<(typeof WORKSPACE_SECRET_SCOPES)[number]>().notNull(),
  /** '' for workspace scope, owner/repo for repository scope. */
  scopeRef: text('scopeRef').notNull().default(''),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  keyVersion: integer('keyVersion').notNull(),
  createdBy: text('createdBy').notNull(),
  updatedBy: text('updatedBy').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('workspace_secrets_name_key').on(table.workspaceId, table.scopeType, table.scopeRef, table.name)])

export const workspaceApiKeyCredentials = pgTable('workspace_api_key_credentials', {
  connectionId: uuid('connectionId').primaryKey(),
  workspaceId: text('workspaceId').notNull(),
  providerSlug: text('providerSlug').notNull(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  keyVersion: integer('keyVersion').notNull(),
  last4: text('last4'),
  createdBy: text('createdBy').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})

export const workspaceE2bKeys = pgTable('workspace_e2b_keys', {
  workspaceId: uuid('workspaceId').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  keyVersion: integer('keyVersion').notNull(),
  last4: text('last4').notNull(),
  e2bTeamHint: text('e2bTeamHint'),
  verifiedAt: timestamp('verifiedAt', { withTimezone: true }),
  lastErrorCode: text('lastErrorCode').$type<(typeof E2B_KEY_ERROR_CODES)[number]>(),
  lastErrorAt: timestamp('lastErrorAt', { withTimezone: true }),
  createdBy: text('createdBy').notNull(),
  updatedBy: text('updatedBy').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})
