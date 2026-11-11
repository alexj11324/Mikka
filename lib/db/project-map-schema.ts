import { pgTable, uuid, text, varchar, jsonb, timestamp, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { issues, agentRuns, factoryTasks } from './schema.ts'

/** Immutable project decisions; AI conversation bodies remain in their original Mikka tables. */
export const projectDecisions = pgTable('project_decisions', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspaceId').notNull(), projectId: uuid('projectId').notNull(),
  /** Immutable author identity; shared Project history outlives an account. */
  ownerId: text('ownerId').notNull(),
  issueId: uuid('issueId').references(() => issues.id, { onDelete: 'set null' }),
  factoryTaskId: uuid('factoryTaskId').references(() => factoryTasks.id, { onDelete: 'set null' }),
  runId: uuid('runId').references(() => agentRuns.id, { onDelete: 'set null' }),
  kind: text('kind').$type<'choose' | 'redirect' | 'abandon' | 'merge' | 'confirm'>().notNull(),
  title: varchar('title', { length: 200 }).notNull(), summary: varchar('summary', { length: 500 }).notNull(), reason: text('reason').notNull(),
  options: jsonb('options').$type<import('../project-map/contracts').DecisionOption[]>().notNull().default([]),
  selectedOptionId: text('selectedOptionId'),
  contextOptionRef: jsonb('contextOptionRef').$type<{ decisionId: string; optionId: string } | null>(),
  predecessorDecisionIds: uuid('predecessorDecisionIds').array().notNull().default(sql`'{}'::uuid[]`),
  provenance: text('provenance').$type<'recorded' | 'inferred'>().notNull(),
  captureMode: text('captureMode').$type<'live' | 'human_marked' | 'reconstructed'>().notNull(),
  decidedBy: jsonb('decidedBy').$type<{ kind: 'human' | 'bot' | 'agent' | 'unknown'; id: string }>().notNull(),
  recordedBy: jsonb('recordedBy').$type<{ kind: 'human' | 'bot' | 'agent'; id: string; userId: string; botId: string | null; runId: string | null; modelId: string | null; harness: string | null; identityAssurance: string }>().notNull(),
  occurredAt: timestamp('occurredAt', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recordedAt', { withTimezone: true }).notNull().defaultNow(),
  supersedesId: uuid('supersedesId').references((): AnyPgColumn => projectDecisions.id, { onDelete: 'set null' }),
  recordStatus: text('recordStatus').$type<'active' | 'retracted'>().notNull().default('active'),
  idempotencyKey: text('idempotencyKey').notNull(), payloadHash: text('payloadHash').notNull(),
}, table => [
  uniqueIndex('project_decisions_idempotency_idx').on(table.workspaceId, table.projectId, table.ownerId, table.idempotencyKey),
  uniqueIndex('project_decisions_supersedes_idx').on(table.supersedesId).where(sql`${table.supersedesId} IS NOT NULL`),
  index('project_decisions_project_time_idx').on(table.workspaceId, table.projectId, table.recordedAt, table.id),
  index('project_decisions_run_idx').on(table.runId).where(sql`${table.runId} IS NOT NULL`),
  index('project_decisions_issue_idx').on(table.issueId).where(sql`${table.issueId} IS NOT NULL`),
])

export const projectDecisionSources = pgTable('project_decision_sources', {
  id: uuid('id').primaryKey(),
  decisionId: uuid('decisionId').notNull().references(() => projectDecisions.id, { onDelete: 'cascade' }),
  /** The source's historical author, not an account-deletion cascade boundary. */
  ownerId: text('ownerId').notNull(),
  workspaceId: uuid('workspaceId').notNull(),
  role: text('role').$type<'evidence' | 'branch_work' | 'stopped_at' | 'merges_from'>().notNull(),
  optionId: text('optionId'),
  sourceType: text('sourceType').notNull(), sourceId: text('sourceId').notNull(),
  locator: jsonb('locator').$type<import('../project-map/contracts').DecisionSourceLocator>().notNull(),
  relation: text('relation').$type<'host_verified' | 'declared' | 'inferred'>().notNull(),
  normalizedKey: text('normalizedKey').notNull(),
  verifiedAt: timestamp('verifiedAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('project_decision_sources_key_idx').on(table.decisionId, table.normalizedKey),
  index('project_decision_sources_lookup_idx').on(table.workspaceId, table.sourceType, table.sourceId),
])
