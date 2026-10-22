import { pgTable, text, uuid, varchar, jsonb, integer, timestamp, primaryKey, index, unique, uniqueIndex, boolean } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { JSONContent } from '@tiptap/react'
import type { HarnessInfo } from '@mikka/protocol/harness'

export const users = pgTable('user', {
  id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull(), image: text('image'),
})
export const issueMembers = pgTable('issue_members', {
  issueId: uuid('issueId').notNull(), userId: text('userId').notNull(), memberId: text('memberId').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.issueId, table.memberId] })])
export const issueDocuments = pgTable('issue_documents', {
  issueId: uuid('issueId').primaryKey(), userId: text('userId').notNull(), state: text('state').notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export const issues = pgTable('issues', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  content: jsonb('content').$type<JSONContent>().notNull(),
  status: text('status').notNull(), priority: text('priority').notNull(),
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})
export const issueVersions = pgTable('issue_versions', {
  id: uuid('id').primaryKey(), issueId: uuid('issueId').notNull(), userId: text('userId').notNull(),
  revision: integer('revision').notNull(), title: varchar('title', { length: 200 }).notNull(),
  content: jsonb('content').$type<JSONContent>().notNull(), status: text('status').notNull(), priority: text('priority').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})

/** OAuth grants and sync state live beside issues so webhook inbox/outbox writes are atomic. */
export const linearOAuthStates = pgTable('linear_oauth_states', {
  stateHash: text('stateHash').primaryKey(), userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  verifier: text('verifier').notNull(), expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})
export const linearConnections = pgTable('linear_connections', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  linearUserId: text('linearUserId').notNull(), organizationId: text('organizationId').notNull(), organizationName: text('organizationName').notNull(),
  accessToken: text('accessToken').notNull(), refreshToken: text('refreshToken').notNull(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(), revokedAt: timestamp('revokedAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})
export const linearTeamSyncs = pgTable('linear_team_syncs', {
  id: uuid('id').primaryKey(), ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  linearTeamId: text('linearTeamId').notNull().unique(), linearTeamKey: text('linearTeamKey').notNull(), linearTeamName: text('linearTeamName').notNull(),
  active: boolean('active').notNull().default(true), lastError: text('lastError'), lastErrorAt: timestamp('lastErrorAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('linear_team_syncs_owner_idx').on(table.ownerId, table.active), uniqueIndex('linear_team_syncs_one_active_per_owner_key').on(table.ownerId).where(sql`${table.active}`)])
export const linearIssueLinks = pgTable('linear_issue_links', {
  id: uuid('id').primaryKey(), issueId: uuid('issueId').notNull().unique().references(() => issues.id, { onDelete: 'cascade' }),
  ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  teamSyncId: uuid('teamSyncId').notNull().references(() => linearTeamSyncs.id, { onDelete: 'cascade' }),
  linearIssueId: text('linearIssueId').notNull().unique(), linearIdentifier: text('linearIdentifier').notNull(), linearDescriptionHash: text('linearDescriptionHash'),
  syncStatus: text('syncStatus').notNull().default('synced'), lastError: text('lastError'),
  appSyncedAt: timestamp('appSyncedAt', { withTimezone: true }), linearUpdatedAt: timestamp('linearUpdatedAt', { withTimezone: true }),
  remoteRemovedAt: timestamp('remoteRemovedAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('linear_issue_links_team_idx').on(table.teamSyncId)])
export const linearCommentLinks = pgTable('linear_comment_links', {
  id: uuid('id').primaryKey(), issueLinkId: uuid('issueLinkId').notNull().references(() => linearIssueLinks.id, { onDelete: 'cascade' }),
  threadId: text('threadId').notNull(), messageId: text('messageId').notNull(), authorUserId: text('authorUserId'), linearCommentId: text('linearCommentId').notNull().unique(),
  parentLinearCommentId: text('parentLinearCommentId'), bodyHash: text('bodyHash').notNull(), syncStatus: text('syncStatus').notNull().default('pending'), lastError: text('lastError'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('linear_comment_links_local_key').on(table.issueLinkId, table.threadId, table.messageId)])
export const linearSyncOutbox = pgTable('linear_sync_outbox', {
  id: uuid('id').primaryKey(), issueId: uuid('issueId').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('queued'), attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('availableAt', { withTimezone: true }).notNull().defaultNow(), lastError: text('lastError'),
  lastAttemptAt: timestamp('lastAttemptAt', { withTimezone: true }), createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('linear_sync_outbox_ready_idx').on(table.status, table.availableAt)])
export const linearSyncInbox = pgTable('linear_sync_inbox', {
  deliveryId: text('deliveryId').primaryKey(), organizationId: text('organizationId').notNull(), eventType: text('eventType').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(), status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0), availableAt: timestamp('availableAt', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('lastError'), lastAttemptAt: timestamp('lastAttemptAt', { withTimezone: true }),
  receivedAt: timestamp('receivedAt', { withTimezone: true }).notNull().defaultNow(), processedAt: timestamp('processedAt', { withTimezone: true }),
}, table => [index('linear_sync_inbox_ready_idx').on(table.status, table.availableAt)])

// --- Devices, agents and runs ---------------------------------------------
//
// The daemon owns detection and execution; the server stores what it reports.
// `devices.harnesses` is exactly the daemon's `HarnessInfo[]` from its latest
// heartbeat, so the UI never guesses what a machine has installed.

/** Harnesses this app drives. Cursor and mock stay out until we support them. */
export const SUPPORTED_HARNESSES = ['claude_code', 'codex'] as const
export type SupportedHarness = (typeof SUPPORTED_HARNESSES)[number]

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey(), ownerId: text('ownerId').notNull(),
  name: text('name').notNull(), hostname: text('hostname'),
  platform: text('platform'), arch: text('arch'),
  daemonVersion: text('daemonVersion'), protocolVersion: integer('protocolVersion'),
  harnesses: jsonb('harnesses').$type<HarnessInfo[]>().notNull().default([]),
  /** Off: the device stays registered but the orchestrator gives it no runs. */
  enabled: boolean('enabled').notNull().default(true),
  maxConcurrentRuns: integer('maxConcurrentRuns').notNull().default(3),
  lastSeenAt: timestamp('lastSeenAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('devices_owner_idx').on(table.ownerId)])

/** A daemon credential. Only the SHA-256 hash is stored. */
export const deviceTokens = pgTable('device_tokens', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  name: text('name').notNull().default(''),
  tokenHash: text('tokenHash').notNull(),
  lastUsedAt: timestamp('lastUsedAt', { withTimezone: true }),
  revokedAt: timestamp('revokedAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('device_tokens_hash_key').on(table.tokenHash), index('device_tokens_user_idx').on(table.userId)])

/** A git repo on a device that agents may work in. */
export const deviceRepos = pgTable('device_repos', {
  id: uuid('id').primaryKey(), deviceId: uuid('deviceId').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull(), repoPath: text('repoPath').notNull(), remoteUrl: text('remoteUrl'),
  baseBranch: text('baseBranch').notNull().default('main'), verifyCommand: text('verifyCommand'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('device_repos_key').on(table.deviceId, table.repoPath)])

/** A named role run by one harness on one device. */
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  harness: text('harness').$type<SupportedHarness>().notNull(),
  name: text('name').notNull(), description: text('description').notNull().default(''),
  instructions: text('instructions').notNull().default(''),
  deviceId: uuid('deviceId').references(() => devices.id, { onDelete: 'set null' }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('agents_user_name_key').on(table.userId, sql`lower(${table.name})`), index('agents_device_idx').on(table.deviceId)])

export const RUN_STATUSES = ['queued', 'preparing', 'running', 'waiting_input', 'finishing', 'succeeded', 'stopped', 'failed', 'cancelled'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** One execution of one agent. The daemon claims it, runs it and reports back. */
export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  issueId: uuid('issueId').references(() => issues.id, { onDelete: 'cascade' }),
  agentId: uuid('agentId').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  deviceId: uuid('deviceId').references(() => devices.id, { onDelete: 'set null' }),
  deviceRepoId: uuid('deviceRepoId').references(() => deviceRepos.id, { onDelete: 'set null' }),
  status: text('status').$type<RunStatus>().notNull().default('queued'),
  kind: text('kind').notNull().default('implement'),
  prompt: text('prompt').notNull().default(''),
  baseBranch: text('baseBranch').notNull().default('main'),
  sessionId: text('sessionId'), worktreePath: text('worktreePath'),
  stopReason: text('stopReason'), error: text('error'),
  report: jsonb('report').$type<Record<string, unknown> | null>(),
  leaseExpiresAt: timestamp('leaseExpiresAt', { withTimezone: true }),
  stopRequestedAt: timestamp('stopRequestedAt', { withTimezone: true }),
  startedAt: timestamp('startedAt', { withTimezone: true }),
  finishedAt: timestamp('finishedAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('agent_runs_device_status_idx').on(table.deviceId, table.status), index('agent_runs_issue_idx').on(table.issueId, table.createdAt)])

/** The run's event stream, one row per chunk; `seq` dedupes re-sent batches. */
export const runChunks = pgTable('run_chunks', {
  id: uuid('id').primaryKey(), runId: uuid('runId').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(), chunk: jsonb('chunk').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('run_chunks_run_seq_key').on(table.runId, table.seq)])

/**
 * Something a person's Coordinator should hear about: a message from the
 * person, a run that ended, or an issue that moved to done. Written where it
 * happens; the Coordinator reads the undelivered rows and marks them.
 * `dedupeKey` keeps a repeated write to one row.
 */
export const COORDINATOR_EVENT_KINDS = ['user_message', 'run_finished', 'issue_done'] as const
export type CoordinatorEventKind = (typeof COORDINATOR_EVENT_KINDS)[number]

export const coordinatorEvents = pgTable('coordinator_events', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  kind: text('kind').$type<CoordinatorEventKind>().notNull(),
  dedupeKey: text('dedupeKey').notNull().unique('coordinator_events_dedupe_key'),
  issueId: uuid('issueId').references(() => issues.id, { onDelete: 'cascade' }),
  runId: uuid('runId').references(() => agentRuns.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  deliveredAt: timestamp('deliveredAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('coordinator_events_pending_idx').on(table.userId, table.deliveredAt, table.createdAt)])

/**
 * One person's Coordinator. A turn holds the lease (`leaseHolder` until
 * `leaseUntil`) while it works, so two wakes never run the same conversation
 * at once. `summary` replaces every message at or before `summaryThrough`
 * when the history is sent to the model. `memory` is what the person asked it to remember, as Markdown lines; it
 * goes into every prompt.
 */
export const coordinatorSessions = pgTable('coordinator_sessions', {
  userId: text('userId').primaryKey(),
  leaseHolder: text('leaseHolder'),
  leaseUntil: timestamp('leaseUntil', { withTimezone: true }),
  summary: text('summary'),
  summaryThrough: integer('summaryThrough').notNull().default(0),
  memory: text('memory').notNull().default(''),
  /** Why the last turn failed; cleared when a turn answers. */
  lastError: text('lastError'),
  lastErrorAt: timestamp('lastErrorAt', { withTimezone: true }),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/** The Coordinator's conversation, one AI SDK model message per row, in `position` order. */
export const coordinatorMessages = pgTable('coordinator_messages', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  position: integer('position').notNull(),
  message: jsonb('message').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('coordinator_messages_position_key').on(table.userId, table.position)])

/** A message a person sent a running agent, delivered on its next poll. */
export const runMessages = pgTable('run_messages', {
  id: uuid('id').primaryKey(), runId: uuid('runId').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull(), text: text('text').notNull(),
  deliveredAt: timestamp('deliveredAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('run_messages_run_idx').on(table.runId, table.createdAt)])
