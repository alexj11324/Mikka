import { pgTable, text, uuid, varchar, jsonb, bigint, integer, real, timestamp, primaryKey, index, unique, uniqueIndex, boolean, customType, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { JSONContent } from '@tiptap/react'
import type { HarnessInfo } from '@mikka/protocol/harness'

export const users = pgTable('user', {
  id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull(), image: text('image'),
})
export const issueMembers = pgTable('issue_members', {
  issueId: uuid('issueId').notNull(), userId: text('userId').notNull(), memberId: text('memberId').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.issueId, table.memberId] }), index('issue_members_member_idx').on(table.memberId, table.issueId)])
export const issueDocuments = pgTable('issue_documents', {
  issueId: uuid('issueId').primaryKey(), userId: text('userId').notNull(), state: text('state').notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export const issues = pgTable('issues', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  content: jsonb('content').$type<JSONContent>().notNull(),
  status: text('status').notNull(), priority: text('priority').notNull(),
  // Workspace issues sync with Linear; personal ones never leave Mikka (MIK-46).
  scope: text('scope').$type<'workspace' | 'personal'>().notNull().default('personal'),
  // The agent judges scope at creation; a person's change wins and teaches the next judgment (MIK-47).
  scopeSetBy: text('scopeSetBy').$type<'agent' | 'user'>().notNull().default('agent'),
  scopeConfidence: real('scopeConfidence'),
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('issues_owner_updated_idx').on(table.userId, table.updatedAt.desc())])
// The personal issue prefix someone chose; without a row it comes from their email (MIK-46).
export const issuePrefixes = pgTable('issue_prefixes', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  prefix: varchar('prefix', { length: 4 }).notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})
/**
 * A bot: what a person chats with in the left column. It runs only on Mikka's
 * own harness (AI SDK), never on a coding agent, so it is not a row in `agents`.
 */
export const bots = pgTable('bots', {
  id: uuid('id').primaryKey(),
  /** Who made it, in which workspace: the identity the cloud computer (bot_desktops, #317) keys on too. */
  ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspaceId').notNull(),
  name: text('name').notNull(),
  /** A bloub colour id, see components/nav/bot-avatar.tsx. */
  color: text('color').notNull().default('encre'),
  shape: text('shape').notNull().default('cercle'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('bots_id_workspace_owner_key').on(table.id, table.workspaceId, table.ownerId), index('bots_owner_workspace_idx').on(table.ownerId, table.workspaceId), uniqueIndex('bots_owner_workspace_name_key').on(table.ownerId, table.workspaceId, sql`lower(${table.name})`)])

export const agentSessions = pgTable('agent_sessions', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(), title: varchar('title', { length: 200 }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('agent_sessions_user_updated_idx').on(table.userId, table.updatedAt.desc())])

export const agentTurns = pgTable('agent_turns', {
  id: uuid('id').primaryKey(), sessionId: uuid('sessionId').notNull(), userId: text('userId').notNull(),
  prompt: text('prompt').notNull(), completion: text('completion').notNull().default(''),
  status: text('status').$type<'pending' | 'complete' | 'failed' | 'stopped'>().notNull().default('pending'),
  error: text('error'), attemptId: uuid('attemptId').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('agent_turns_session_user_created_idx').on(table.sessionId, table.userId, table.createdAt)])

export const issueVersions = pgTable('issue_versions', {
  id: uuid('id').primaryKey(), issueId: uuid('issueId').notNull(), userId: text('userId').notNull(),
  revision: integer('revision').notNull(), title: varchar('title', { length: 200 }).notNull(),
  content: jsonb('content').$type<JSONContent>().notNull(), status: text('status').notNull(), priority: text('priority').notNull(),
  // Who made the change; set on the server only. Null on rows written before 20261025200000_activity_version_actor.
  actorType: text('actor_type').$type<'user' | 'agent' | 'system'>(), actorId: text('actor_id'),
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
  /** The bot that started this thread; null for runs started from a task directly. */
  botId: uuid('botId').references(() => bots.id, { onDelete: 'set null' }),
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
  /** 1 for the first run; a retry after the device went offline counts up (lib/run-retry.ts). */
  attempt: integer('attempt').notNull().default(1),
  /** The run this one retries, when its device went offline. */
  retryOf: uuid('retryOf').references((): AnyPgColumn => agentRuns.id, { onDelete: 'set null' }),
  stopRequestedAt: timestamp('stopRequestedAt', { withTimezone: true }),
  startedAt: timestamp('startedAt', { withTimezone: true }),
  finishedAt: timestamp('finishedAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('agent_runs_device_status_idx').on(table.deviceId, table.status), index('agent_runs_issue_idx').on(table.issueId, table.createdAt), index('agent_runs_bot_created_idx').on(table.botId, table.createdAt.desc()).where(sql`${table.botId} is not null`)])

/** The run's event stream, one row per chunk; `seq` dedupes re-sent batches. */
export const runChunks = pgTable('run_chunks', {
  id: uuid('id').primaryKey(), runId: uuid('runId').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(), chunk: jsonb('chunk').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('run_chunks_run_seq_key').on(table.runId, table.seq)])

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

/**
 * The latest work in progress of a run, saved by the daemon so another
 * machine can take the run over (lib/run-leases.ts). `patch` is a gzipped
 * `git diff --binary` against `baseCommit`.
 */
export const runCheckpoints = pgTable('run_checkpoints', {
  runId: uuid('runId').primaryKey().references(() => agentRuns.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull(), baseCommit: text('baseCommit').notNull(),
  patch: bytea('patch').notNull(), files: integer('files').notNull(),
  takenAt: timestamp('takenAt', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A token the agent inside one run uses for the worker tools of the MCP
 * server. Handed to the daemon with the claim; good only while the run is
 * live. Only the SHA-256 hash is stored.
 */
export const runTokens = pgTable('run_tokens', {
  id: uuid('id').primaryKey(), runId: uuid('runId').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull(), tokenHash: text('tokenHash').notNull(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revokedAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('run_tokens_hash_key').on(table.tokenHash), index('run_tokens_run_idx').on(table.runId)])

/**
 * Something a person's Coordinator should hear about: a message from the
 * person, a run that ended, or an issue that moved to done. Written where it
 * happens; the Coordinator reads the undelivered rows and marks them.
 * `dedupeKey` keeps a repeated write to one row.
 */
/**
 * `action_decided` follows the person approving or declining a pending action.
 * `run_report`, `run_question` and `run_blocked` come from the agent inside a
 * run, through the worker tools of the MCP server (lib/mcp/worker.ts).
 * `artifact_submitted` comes from `submit_artifact`, from a run or an OAuth agent.
 */
export const COORDINATOR_EVENT_KINDS = ['user_message', 'run_finished', 'issue_done', 'run_report', 'run_question', 'run_blocked', 'run_retried', 'action_decided', 'artifact_submitted', 'daily_briefing'] as const
export type CoordinatorEventKind = (typeof COORDINATOR_EVENT_KINDS)[number]
/**
 * How much an event matters: `attention` needs the person, `result` is worth
 * a short note, `background` waits for the next turn without waking one.
 */
export const COORDINATOR_EVENT_TIERS = ['attention', 'result', 'background'] as const
export type CoordinatorEventTier = (typeof COORDINATOR_EVENT_TIERS)[number]

export const coordinatorEvents = pgTable('coordinator_events', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  /** The bot whose chat this is for; null for the Coordinator's. */
  botId: uuid('botId').references(() => bots.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<CoordinatorEventKind>().notNull(),
  dedupeKey: text('dedupeKey').notNull().unique('coordinator_events_dedupe_key'),
  issueId: uuid('issueId').references(() => issues.id, { onDelete: 'cascade' }),
  runId: uuid('runId').references(() => agentRuns.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  /** Null until triaged; an untriaged event wakes the Coordinator. */
  tier: text('tier').$type<CoordinatorEventTier>(),
  deliveredAt: timestamp('deliveredAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('coordinator_events_pending_idx').on(table.userId, table.deliveredAt, table.createdAt)])

/**
 * One person's Coordinator, or one of their bots (`botId`), which runs on the
 * same harness with its own conversation and memory. A turn holds the lease (`leaseHolder` until
 * `leaseUntil`) while it works, so two wakes never run the same conversation
 * at once. `summary` replaces every message at or before `summaryThrough`
 * when the history is sent to the model. `memory` is what the person asked it to remember, as Markdown lines; it
 * goes into every prompt.
 */
export const coordinatorSessions = pgTable('coordinator_sessions', {
  userId: text('userId').notNull(),
  /** A bot's own conversation on the same harness; null for the Coordinator. */
  botId: uuid('botId').references(() => bots.id, { onDelete: 'cascade' }),
  leaseHolder: text('leaseHolder'),
  leaseUntil: timestamp('leaseUntil', { withTimezone: true }),
  summary: text('summary'),
  summaryThrough: integer('summaryThrough').notNull().default(0),
  memory: text('memory').notNull().default(''),
  /** Why the last turn failed; cleared when a turn answers. */
  lastError: text('lastError'),
  lastErrorAt: timestamp('lastErrorAt', { withTimezone: true }),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('coordinator_sessions_chat_key').on(table.userId, table.botId).nullsNotDistinct()])

// --- Suggestions (MIK-41) ---------------------------------------------------
//
// External notifications from connected apps, judged by fixed rules or the
// decision model (lib/suggestions). Only `shown` rows reach the person; hidden
// rows stay so a repeat delivery is not judged again. The Coordinator never
// writes here.

/** The connected apps a suggestion can come from. */
export const SUGGESTION_SOURCES = ['gmail', 'slack', 'notion', 'github', 'linear'] as const
export type SuggestionSource = (typeof SUGGESTION_SOURCES)[number]
/** What the person would do with it: answer, review a PR, take on an assigned issue, or read. */
export const SUGGESTION_ACTIONS = ['reply', 'review', 'handle', 'read'] as const
export type SuggestionAction = (typeof SUGGESTION_ACTIONS)[number]
/** Who decided: a fixed rule, the decision model, or the fallback when the model did not answer. */
export type SuggestionDecider = 'rule' | 'model' | 'fallback'

export const suggestions = pgTable('suggestions', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  source: text('source').$type<SuggestionSource>().notNull(),
  externalId: text('externalId').notNull(),
  action: text('action').$type<SuggestionAction>().notNull(),
  /** The source's own text: the email subject, the Slack message, the PR title. */
  title: text('title').notNull(), url: text('url'), actor: text('actor'),
  shown: boolean('shown').notNull(),
  decidedBy: text('decidedBy').$type<SuggestionDecider>().notNull(),
  probability: real('probability'),
  /** Assigned to the person or their review is requested. */
  required: boolean('required').notNull().default(false),
  occurredAt: timestamp('occurredAt', { withTimezone: true }).notNull(),
  dismissedAt: timestamp('dismissedAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('suggestions_external_key').on(table.userId, table.source, table.externalId), index('suggestions_user_shown_idx').on(table.userId, table.shown, table.createdAt)])

/**
 * The "早上好" briefing, one per person per local day. `first` is written
 * right after the person connects an app; `daily` at 08:00 the person's time
 * by the briefings cron, or by the first read after 08:00 if the cron has not
 * run (an empty `daily` only marks the day as done). `highlights` are
 * suggestion ids the briefing names.
 */
export const briefings = pgTable('briefings', {
  userId: text('userId').notNull(), localDate: text('localDate').notNull(),
  kind: text('kind').$type<'first' | 'daily'>().notNull(), timeZone: text('timeZone').notNull(),
  highlights: jsonb('highlights').$type<string[]>().notNull(),
  counts: jsonb('counts').$type<Partial<Record<SuggestionSource, number>>>().notNull(),
  total: integer('total').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.userId, table.localDate] })])

/** When the person's Composio trigger subscriptions were last checked (lib/suggestions/sources.ts). */
export const suggestionTriggerChecks = pgTable('suggestion_trigger_checks', {
  userId: text('userId').primaryKey(),
  checkedAt: timestamp('checkedAt', { withTimezone: true }).notNull(),
})

/**
 * Each person's IANA time zone, so the daily briefing is written at 08:00
 * their time (app/api/cron/briefings). The browser's zone, sent when the
 * suggestions list loads, replaces any earlier value; the connect callbacks'
 * IP-derived zone only fills a gap.
 */
export const userTimeZones = pgTable('user_time_zones', {
  userId: text('userId').primaryKey(),
  timeZone: text('timeZone').notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('user_time_zones_zone_idx').on(table.timeZone)])

/** The Coordinator's conversation, one AI SDK model message per row, in `position` order. */
export const coordinatorMessages = pgTable('coordinator_messages', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  botId: uuid('botId').references(() => bots.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  message: jsonb('message').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('coordinator_messages_position_key').on(table.userId, table.botId, table.position).nullsNotDistinct()])

/** A message a person sent a running agent, delivered on its next poll. */
export const runMessages = pgTable('run_messages', {
  id: uuid('id').primaryKey(), runId: uuid('runId').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull(), text: text('text').notNull(),
  deliveredAt: timestamp('deliveredAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('run_messages_run_idx').on(table.runId, table.createdAt)])

/**
 * An OAuth client, such as Claude Code or Codex, registered with the OAuth
 * provider plugin in lib/auth.ts. The plugin owns this table (0009); only the
 * columns the app reads are listed.
 */
export const oauthClients = pgTable('oauthClient', {
  id: text('id').primaryKey(), clientId: text('clientId').notNull().unique(),
  name: text('name'), uri: text('uri'),
})

export const telegramLinks = pgTable('telegram_links', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  telegramUserId: text('telegramUserId').notNull(),
  telegramUserName: text('telegramUserName'),
  linkedAt: timestamp('linkedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('telegram_links_telegram_user_key').on(table.telegramUserId)])

export const telegramLinkTokens = pgTable('telegram_link_tokens', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('tokenHash').notNull(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('telegram_link_tokens_hash_key').on(table.tokenHash)])

export const telegramConversations = pgTable('telegram_conversations', {
  threadId: text('threadId').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  issueId: uuid('issueId').references(() => issues.id, { onDelete: 'set null' }),
  draftTitle: varchar('draftTitle', { length: 200 }),
  draftDescription: text('draftDescription').notNull().default(''),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('telegram_conversations_user_idx').on(table.userId)])

/** Group history retains former memberships; agent DMs are exposed only through links. */
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey(), workspaceId: uuid('workspaceId').notNull(),
  kind: text('kind').$type<'group' | 'agent_dm'>().notNull(), title: text('title').notNull(),
  createdBy: text('createdBy').notNull(), lastPosition: bigint('lastPosition', { mode: 'bigint' }).notNull().default(sql`0`),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})
export const conversationMembers = pgTable('conversation_members', {
  conversationId: uuid('conversationId').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  memberType: text('memberType').$type<'user' | 'agent'>().notNull(), memberId: text('memberId').notNull(),
  role: text('role').$type<'owner' | 'member'>().notNull(),
  joinedAt: timestamp('joinedAt', { withTimezone: true }).notNull().defaultNow(), leftAt: timestamp('leftAt', { withTimezone: true }),
}, t => [primaryKey({ columns: [t.conversationId, t.memberType, t.memberId] }), index('conversation_members_identity_idx').on(t.memberType, t.memberId)])
export const conversationMessages = pgTable('conversation_messages', {
  id: uuid('id').primaryKey(), conversationId: uuid('conversationId').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  position: bigint('position', { mode: 'bigint' }).notNull(), authorType: text('authorType').$type<'user' | 'agent'>().notNull(),
  authorId: text('authorId').notNull(), body: text('body').notNull(), mentions: jsonb('mentions').notNull().default([]),
  replyToId: uuid('replyToId'), createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, t => [unique('conversation_messages_position_key').on(t.conversationId, t.position), index('conversation_messages_timeline_idx').on(t.conversationId, t.position.desc())])
// Same names/types as unmerged MIK-8 (#69); deliberately no FK: 'coordinator' is also a valid id.
export const conversationReads = pgTable('conversation_reads', {
  userId: text('userId').notNull(), conversationId: text('conversationId').notNull(),
  lastReadPosition: integer('lastReadPosition').notNull().default(0), lastReadMessageId: text('lastReadMessageId'),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.userId, t.conversationId] })])
export const conversationLinks = pgTable('conversation_links', {
  id: uuid('id').primaryKey(), sourceConversationId: uuid('sourceConversationId').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  linkedConversationId: uuid('linkedConversationId').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  anchorPosition: bigint('anchorPosition', { mode: 'bigint' }).notNull(), firstPosition: bigint('firstPosition', { mode: 'bigint' }).notNull(),
  lastPosition: bigint('lastPosition', { mode: 'bigint' }).notNull(), messageCount: bigint('messageCount', { mode: 'bigint' }).notNull(),
}, t => [index('conversation_links_source_idx').on(t.sourceConversationId, t.anchorPosition)])

// --- Artifacts ---------------------------------------------------------------
//
// A document (Markdown) or web page (HTML) an agent hands over through the MCP
// tool `submit_artifact` (lib/artifacts). Each version's file sits in R2 under
// `storageKey`, immutable; this table keeps who, when and which version.

export const ARTIFACT_KINDS = ['markdown', 'html'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  kind: text('kind').$type<ArtifactKind>().notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  /** The run that made it; null when an agent outside a run (OAuth) sent it. */
  runId: uuid('runId').references(() => agentRuns.id, { onDelete: 'set null' }),
  issueId: uuid('issueId').references(() => issues.id, { onDelete: 'set null' }),
  latestVersion: integer('latestVersion').notNull().default(1),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('artifacts_user_idx').on(table.userId, table.updatedAt), index('artifacts_run_idx').on(table.runId)])

export const artifactVersions = pgTable('artifact_versions', {
  id: uuid('id').primaryKey(),
  artifactId: uuid('artifactId').notNull().references(() => artifacts.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  /** Object key in the artifacts bucket. */
  storageKey: text('storageKey').notNull(),
  /** The file itself, only where no bucket is configured (previews, tests); production always uses R2. */
  inlineContent: text('inlineContent'),
  sha256: text('sha256').notNull(), size: integer('size').notNull(),
  /** Who made this version: the agent's name or the OAuth client's. */
  authorName: text('authorName').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('artifact_versions_version_key').on(table.artifactId, table.version)])

/** A link anyone can open at /a/<token>. Only the token's hash is stored; revoking ends it. */
export const artifactShares = pgTable('artifact_shares', {
  id: uuid('id').primaryKey(),
  artifactId: uuid('artifactId').notNull().references(() => artifacts.id, { onDelete: 'cascade' }),
  tokenHash: text('tokenHash').notNull(), createdBy: text('createdBy').notNull(),
  revokedAt: timestamp('revokedAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('artifact_shares_token_key').on(table.tokenHash), index('artifact_shares_artifact_idx').on(table.artifactId)])
/**
 * Something an agent wants to do in the person's own accounts (send an email,
 * create or change a calendar event). It stays `pending` until the person
 * approves or declines it; approving runs exactly `input` (lib/pending-actions.ts).
 * `context` is what the card shows besides the input, such as the event being changed.
 */
export const PENDING_ACTION_STATUSES = ['pending', 'running', 'done', 'failed', 'declined'] as const
export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number]
export const pendingActions = pgTable('pending_actions', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  action: text('action').notNull(),
  input: jsonb('input').$type<Record<string, unknown>>().notNull(),
  context: jsonb('context').$type<Record<string, unknown> | null>(),
  status: text('status').$type<PendingActionStatus>().notNull().default('pending'),
  result: jsonb('result').$type<Record<string, unknown> | null>(), error: text('error'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decidedAt', { withTimezone: true }),
}, table => [index('pending_actions_user_status_idx').on(table.userId, table.status, table.createdAt)])

// Deprecated native Coordinator bridge (#312, decision 2026-10-27). Kept, switched off; see docs/architecture/native-coordinator.md.
export const coordinatorRuntimeSettings = pgTable('coordinator_runtime_settings', {
  userId: text('userId').primaryKey(), runtime: jsonb('runtime').notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})
export const nativeCoordinatorTurns = pgTable('native_coordinator_turns', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  deviceId: uuid('deviceId').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  holder: text('holder').notNull(), round: integer('round').notNull(), payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('queued'), reply: text('reply'),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique().on(table.userId, table.holder, table.round), index('native_coordinator_pending_idx').on(table.deviceId, table.status, table.createdAt)])
export const nativeCoordinatorTools = pgTable('native_coordinator_tools', {
  turnId: uuid('turnId').notNull().references(() => nativeCoordinatorTurns.id, { onDelete: 'cascade' }),
  callId: text('callId').notNull(), name: text('name').notNull(), input: jsonb('input').notNull(),
  status: text('status').notNull().default('pending'), output: jsonb('output'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.turnId, table.callId] })])
