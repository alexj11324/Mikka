import type { WorkerDefinitionSnapshot } from '../agent-kit/worker'
import type { SendKey } from '../send-key'
import { pgTable, text, uuid, varchar, jsonb, bigint, integer, real, date, timestamp, primaryKey, index, unique, uniqueIndex, boolean, customType, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { JSONContent } from '@tiptap/react'
import type { HarnessInfo } from '@mikka/protocol/harness'
import type { SetupRecipe } from '@mikka/protocol/device'
import type { CaptureContentType, CaptureKind, CaptureSource } from '@mikka/protocol/capture'
import type { AttentionLevel } from '@/lib/attention/judgment'
import type { UserFactKind, UserFactState } from '@/lib/profile/kinds'

export const users = pgTable('user', {
  id: text('id').primaryKey(), name: text('name').notNull(), email: text('email').notNull(), image: text('image'),
})
/** A finished or skipped first-run guide; no row means not yet. */
export const userOnboarding = pgTable('user_onboarding', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  completedAt: timestamp('completedAt', { withTimezone: true }).notNull().defaultNow(),
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
  scopeVersion: integer('scopeVersion').notNull().default(1),
  linearSyncBlocked: boolean('linearSyncBlocked').notNull().default(false),
  // The agent judges scope at creation; a person's change wins and teaches the next judgment (MIK-47).
  scopeSetBy: text('scopeSetBy').$type<'agent' | 'user'>().notNull().default('agent'),
  scopeConfidence: real('scopeConfidence'),
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('issues_owner_updated_idx').on(table.userId, table.updatedAt.desc())])
export const teamIssueCreateRequests = pgTable('team_issue_create_requests', {
  requestId: uuid('requestId').primaryKey(), ownerId: text('ownerId').notNull(),
  issueId: uuid('issueId').notNull().unique(), teamId: uuid('teamId').notNull(),
  fingerprint: text('fingerprint').notNull(), status: text('status').$type<'preparing' | 'complete'>().notNull().default('preparing'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})
export const teamIssuePromotions = pgTable('team_issue_promotions', {
  requestId: uuid('requestId').primaryKey(), ownerId: text('ownerId').notNull(), issueId: uuid('issueId').notNull(),
  teamId: uuid('teamId').notNull(), expectedTeamId: uuid('expectedTeamId'), expectedRevision: integer('expectedRevision').notNull(),
  status: text('status').$type<'preparing' | 'complete' | 'stale'>().notNull().default('preparing'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})
// The personal issue prefix someone chose; without a row it comes from their email (MIK-46).
/** A desktop browser handoff, bound to the signed-in person before the browser opens. */
export const desktopAuthRequests = pgTable('desktop_auth_requests', {
  stateHash: text('stateHash').primaryKey(),
  // Null until the browser that finished OAuth binds the request to its person.
  userId: text('userId').references(() => users.id, { onDelete: 'cascade' }),
  callback: text('callback').notNull(),
  codeChallenge: text('codeChallenge').notNull(),
  codeHash: text('codeHash'),
  token: text('token'),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  boundAt: timestamp('boundAt', { withTimezone: true }),
  usedAt: timestamp('usedAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('desktop_auth_requests_user_idx').on(table.userId, table.expiresAt)])

export const issuePrefixes = pgTable('issue_prefixes', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  prefix: varchar('prefix', { length: 4 }).notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/** A successful issue mutation and its Workflow retry identity commit together. */
export const issueToolCalls = pgTable('issue_tool_calls', {
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  toolCallId: text('toolCallId').notNull(),
  operation: text('operation').$type<'create_issue' | 'update_issue'>().notNull(),
  inputHash: text('inputHash').notNull(),
  issueId: uuid('issueId').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  effects: jsonb('effects').$type<import('@/lib/issue-effects').IssueEffect[]>().notNull().default([]),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.userId, table.toolCallId] })])
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
  /** Model family a new bot starts with ('mikka' | 'codex' | 'claude'); copied from workspace_settings. */
  model: text('model').$type<WorkspaceBotModel | null>(),
  /** GitHub repository (owner/repo remote key) a new bot starts with; copied from workspace_settings. */
  repository: text('repository'),
  /** Monthly credit cap for this bot; null uses workspace_settings.botMonthlyCreditLimit. */
  monthlyCreditLimit: integer('monthlyCreditLimit'),
  /** Set when the owner left or was suspended; the bot stays paused until an admin takes it over (§8.3). */
  archivedAt: timestamp('archivedAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('bots_id_workspace_owner_key').on(table.id, table.workspaceId, table.ownerId), index('bots_owner_workspace_idx').on(table.ownerId, table.workspaceId), uniqueIndex('bots_owner_workspace_name_key').on(table.ownerId, table.workspaceId, sql`lower(${table.name})`)])

/** Personal execution preferences in the same workspace scope as Bots. The
 * default uses a null label and is stored alongside label rules. */
export const executionRules = pgTable('execution_rules', {
  id: uuid('id').primaryKey(), ownerId: text('ownerId').notNull().references(()=>users.id,{onDelete:'cascade'}),
  workspaceId: uuid('workspaceId').notNull(), label: text('label'),
  place: text('place').notNull(), harness: text('harness').notNull(),
  model: text('model').notNull(), position: integer('position').notNull(),
}, table=>[index('execution_rules_scope_idx').on(table.ownerId,table.workspaceId), uniqueIndex('execution_rules_default_idx').on(table.ownerId,table.workspaceId).where(sql`${table.label} IS NULL`)])
export const botModelChoices = pgTable('bot_model_choices', {
  ownerId:text('ownerId').notNull().references(()=>users.id,{onDelete:'cascade'}),workspaceId:uuid('workspaceId').notNull(),
  botKey:text('botKey').notNull(),bindingId:uuid('bindingId'),
}, table=>[primaryKey({columns:[table.ownerId,table.workspaceId,table.botKey]})])

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
/** One immutable remote identity per workspace scope generation. Reservation
 * commits before provider IO, so an ambiguous response is retried with this ID. */
export const linearIssuePublications = pgTable('linear_issue_publications', {
  id: uuid('id').primaryKey(), issueId: uuid('issueId').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  ownerId: text('ownerId').notNull(), teamSyncId: uuid('teamSyncId').notNull(),
  scopeVersion: integer('scopeVersion').notNull(), linearIssueId: text('linearIssueId').notNull().unique(),
  writePending: boolean('writePending').notNull().default(false),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp('retiredAt', { withTimezone: true }),
}, table => [uniqueIndex('linear_issue_publications_scope_key').on(table.issueId, table.scopeVersion), uniqueIndex('linear_issue_publications_active_key').on(table.issueId).where(sql`${table.retiredAt} is null`)])
export const linearIssueLinks = pgTable('linear_issue_links', {
  externalTargetVerified: boolean('externalTargetVerified').notNull().default(false),
  publicationId: uuid('publicationId').references(() => linearIssuePublications.id, { onDelete: 'set null' }),
  id: uuid('id').primaryKey(), issueId: uuid('issueId').notNull().unique().references(() => issues.id, { onDelete: 'cascade' }),
  ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  teamSyncId: uuid('teamSyncId').notNull().references(() => linearTeamSyncs.id, { onDelete: 'cascade' }),
  linearIssueId: text('linearIssueId').notNull().unique(), linearIdentifier: text('linearIdentifier').notNull(), linearDescriptionHash: text('linearDescriptionHash'),
  syncStatus: text('syncStatus').notNull().default('synced'), lastError: text('lastError'),
  appSyncedAt: timestamp('appSyncedAt', { withTimezone: true }), linearUpdatedAt: timestamp('linearUpdatedAt', { withTimezone: true }),
  remoteRemovedAt: timestamp('remoteRemovedAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('linear_issue_links_team_idx').on(table.teamSyncId)])
/** A durable deny-list for detached remote identities. Kept separately from
 * active links so delayed webhooks and imports cannot publish a personal task. */
export const linearIssueDetachments = pgTable('linear_issue_detachments', {
  linearIssueId: text('linearIssueId').primaryKey(),
  issueId: uuid('issueId').notNull(), ownerId: text('ownerId').notNull(),
  teamSyncId: uuid('teamSyncId'), linearIdentifier: text('linearIdentifier'),
  sourceLinkId: uuid('sourceLinkId').unique(), publicationId: uuid('publicationId'),
  externalTargetVerified: boolean('externalTargetVerified').notNull().default(false),
  archivedAt: timestamp('archivedAt', { withTimezone: true }),
  detachedAt: timestamp('detachedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('linear_issue_detachments_issue_idx').on(table.issueId)])
export const linearCommentLinks = pgTable('linear_comment_links', {
  id: uuid('id').primaryKey(), issueLinkId: uuid('issueLinkId').notNull().references(() => linearIssueLinks.id, { onDelete: 'cascade' }),
  threadId: text('threadId').notNull(), messageId: text('messageId').notNull(), authorUserId: text('authorUserId'), linearCommentId: text('linearCommentId').notNull().unique(),
  parentLinearCommentId: text('parentLinearCommentId'), bodyHash: text('bodyHash').notNull(), syncStatus: text('syncStatus').notNull().default('pending'), lastError: text('lastError'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('linear_comment_links_local_key').on(table.issueLinkId, table.threadId, table.messageId)])
export const linearSyncOutbox = pgTable('linear_sync_outbox', {
  operation: text('operation').$type<'sync' | 'archive'>().notNull().default('sync'), archiveTarget: jsonb('archiveTarget'),
  scopeVersion: integer('scopeVersion').notNull().default(1), claimToken: uuid('claimToken'),
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
export const SUPPORTED_HARNESSES = ['claude_code', 'codex', 'cursor'] as const
export type SupportedHarness = (typeof SUPPORTED_HARNESSES)[number]

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey(), ownerId: text('ownerId').notNull(),
  name: text('name').notNull(), hostname: text('hostname'),
  kind: text('kind').$type<'local' | 'cloud'>().notNull().default('local'),
  deviceType: text('deviceType').$type<'laptop' | 'server'>().notNull().default('laptop'),
  platform: text('platform'), arch: text('arch'),
  daemonVersion: text('daemonVersion'), protocolVersion: integer('protocolVersion'),
  harnesses: jsonb('harnesses').$type<HarnessInfo[]>().notNull().default([]),
  computerUse: jsonb('computerUse').$type<{ installed: boolean; version: string | null }>().notNull().default({ installed: false, version: null }),
  /** Off: the device stays registered but the orchestrator gives it no runs. */
  enabled: boolean('enabled').notNull().default(true),
  /** 「允许自动调度」: null is the type default (servers on, personal computers off); see lib/device-auto-schedule.ts. */
  autoSchedule: boolean('autoSchedule'),
  /** The person renamed it; a daemon re-register keeps this name. */
  nameLocked: boolean('nameLocked').notNull().default(false),
  /** Removed from settings: a tombstone that keeps run history (lib/device-removal.ts). */
  removedAt: timestamp('removedAt', { withTimezone: true }),
  maxConcurrentRuns: integer('maxConcurrentRuns').notNull().default(3),
  lastSeenAt: timestamp('lastSeenAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('devices_owner_idx').on(table.ownerId)])

/** Better Auth 1.7.12 owns the device authorization lifecycle. */
export const deviceCodes = pgTable('deviceCode', {
  id: text('id').primaryKey(), deviceCode: text('deviceCode').notNull(),
  userCode: text('userCode').notNull(), userId: text('userId'),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  status: text('status').notNull(),
  lastPolledAt: timestamp('lastPolledAt', { withTimezone: true }),
  pollingInterval: integer('pollingInterval'), clientId: text('clientId'), scope: text('scope'),
}, table => [uniqueIndex('device_code_key').on(table.deviceCode), uniqueIndex('device_user_code_key').on(table.userCode)])

/** A daemon credential. Only the SHA-256 hash is stored. */
export const deviceTokens = pgTable('device_tokens', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  name: text('name').notNull().default(''),
  tokenHash: text('tokenHash').notNull(),
  boundDeviceId: uuid('boundDeviceId').references(() => devices.id, { onDelete: 'cascade' }),
  boundWorkspaceId: uuid('boundWorkspaceId'),
  expiresAt: timestamp('expiresAt', { withTimezone: true }),
  lastUsedAt: timestamp('lastUsedAt', { withTimezone: true }),
  revokedAt: timestamp('revokedAt', { withTimezone: true }),
  revokedBy: text('revokedBy'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('device_tokens_hash_key').on(table.tokenHash), index('device_tokens_user_idx').on(table.userId)])

/** Which daemon credential has acted as which device; removing the device revokes these. */
export const deviceTokenDevices = pgTable('device_token_devices', {
  tokenId: uuid('tokenId').notNull().references(() => deviceTokens.id, { onDelete: 'cascade' }),
  deviceId: uuid('deviceId').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.tokenId, table.deviceId] }), index('device_token_devices_device_idx').on(table.deviceId)])

/** A git repo on a device that agents may work in. */
export const deviceRepos = pgTable('device_repos', {
  id: uuid('id').primaryKey(), deviceId: uuid('deviceId').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull(), repoPath: text('repoPath').notNull(), remoteUrl: text('remoteUrl'),
  baseBranch: text('baseBranch').default('main'), verifyCommand: text('verifyCommand'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('device_repos_key').on(table.deviceId, table.repoPath)])

/** Owner-reviewed settings follow a repository across computers and transports. */
export const repositorySettings = pgTable('repository_settings', {
  userId: text('userId').notNull(), remoteKey: text('remoteKey').notNull(),
  verifyCommand: text('verifyCommand'), setup: jsonb('setup').$type<SetupRecipe | null>(),
  networkAllow: jsonb('networkAllow').$type<string[] | null>(),
  push: jsonb('push').$type<import('@/lib/run-publication-policy').RepositoryPushApproval | null>(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.userId, table.remoteKey] })])

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

export const RUN_STATUSES = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing', 'succeeded', 'stopped', 'failed', 'cancelled'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** One execution of one agent. The daemon claims it, runs it and reports back. */
export const agentRuns = pgTable('agent_runs', {
  /** Immutable execution provenance; old rows remain unrecorded. */
  agentDefinition: jsonb('agentDefinition').$type<WorkerDefinitionSnapshot | null>(),
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  issueId: uuid('issueId').references(() => issues.id, { onDelete: 'cascade' }),
  agentId: uuid('agentId').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  /** The bot that started this thread; null for runs started from a task directly. */
  botId: uuid('botId').references(() => bots.id, { onDelete: 'set null' }),
  deviceId: uuid('deviceId').references(() => devices.id, { onDelete: 'set null' }),
  deviceRepoId: uuid('deviceRepoId').references(() => deviceRepos.id, { onDelete: 'set null' }),
  /** Authenticated daemon token that claimed this run; unknown for old runs. */
  deviceTokenId: uuid('deviceTokenId'),
  status: text('status').$type<RunStatus>().notNull().default('queued'),
  pauseReason: text('pauseReason').$type<'human_control' | null>(),
  resumeStatus: text('resumeStatus').$type<RunStatus | null>(),
  kind: text('kind').notNull().default('implement'),
  prompt: text('prompt').notNull().default(''),
  /** Caller-supplied retry identity, scoped to userId. Null for older dispatchers. */
  dispatchKey: text('dispatchKey'),
  /** Hash of the original dispatch parameters; rejects reuse for different work. */
  dispatchFingerprint: text('dispatchFingerprint'),
  baseBranch: text('baseBranch').default('main'),
  sessionId: text('sessionId'), worktreePath: text('worktreePath'),
  stopReason: text('stopReason'), error: text('error'),
  report: jsonb('report').$type<Record<string, unknown> | null>(),
  /** The opening of the agent's last reply (240 characters), written as its text arrives; the right column's row shows it. */
  lastReply: text('lastReply'),
  /** The text part (chunk id) lastReply comes from: more text for it appends, another part replaces it. */
  lastReplyPart: text('lastReplyPart'),
  lastReplyAt: timestamp('lastReplyAt', { withTimezone: true }),
  /** Where the run was dispatched from: 'mcp' for an MCP client, null for the app (the Coordinator, a bot or a task). */
  source: text('source').$type<'mcp' | null>(),
  questionContinuation: jsonb('questionContinuation').$type<{questionId:string; originRunId:string; originSessionId:string; followUp:string; requireSessionResume:true} | null>(),
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
}, table => [index('agent_runs_device_status_idx').on(table.deviceId, table.status), index('agent_runs_issue_idx').on(table.issueId, table.createdAt), index('agent_runs_bot_created_idx').on(table.botId, table.createdAt.desc()).where(sql`${table.botId} is not null`), uniqueIndex('agent_runs_user_dispatch_key').on(table.userId, table.dispatchKey).where(sql`${table.dispatchKey} is not null`), index('agent_runs_retry_of_idx').on(table.retryOf).where(sql`${table.retryOf} is not null`)])

/** A verified owner/repository binding. Installation tokens are never stored. */
export const githubRepositoryInstallations = pgTable('github_repository_installations', {
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  remoteKey: text('remoteKey').notNull(),
  githubAccountId: text('githubAccountId').notNull(),
  installationId: bigint('installationId', { mode: 'number' }).notNull(),
  repositoryId: bigint('repositoryId', { mode: 'number' }).notNull(),
  verifiedAt: timestamp('verifiedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.userId, table.remoteKey] })])

/** Server-issued publication assignment and durable completion receipt (ADR 0024). */
export const runPublications = pgTable('run_publications', {
  runId: uuid('runId').primaryKey().references(() => agentRuns.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  issueId: uuid('issueId').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  scopeVersion: integer('scopeVersion'), issueTitle: text('issueTitle'),
  remoteUrl: text('remoteUrl').notNull(), remoteKey: text('remoteKey').notNull(),
  identifier: text('identifier'), branch: text('branch'), baseBranch: text('baseBranch'),
  pushApproved: boolean('pushApproved').notNull().default(false),
  status: text('status').$type<'assigned' | 'pending' | 'processing' | 'published' | 'blocked' | 'skipped'>().notNull().default('assigned'),
  workflowRunId: text('workflowRunId'), leaseToken: uuid('leaseToken'), leaseExpiresAt: timestamp('leaseExpiresAt', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  pullRequest: jsonb('pullRequest').$type<{ url: string; title?: string; state: 'open' | 'draft' | 'merged' | 'closed' } | null>(),
  errorCode: text('errorCode'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('run_publications_issue_repo_idx').on(table.issueId, table.remoteKey), index('run_publications_pending_idx').on(table.status, table.leaseExpiresAt)])

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
  unavailableReason: text('unavailableReason').$type<'too_large' | null>(),
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
/**
 * `matter_handoff` carries hidden evidence from connected apps
 * (lib/attention): the person has not seen it, and the Coordinator alone
 * decides whether to tell them.
 */
export const COORDINATOR_EVENT_KINDS = ['user_message', 'run_finished', 'issue_done', 'run_report', 'run_question', 'run_blocked', 'run_retried', 'action_decided', 'artifact_submitted', 'daily_briefing', 'matter_handoff', 'run_dispatch_failed', 'run_redispatched'] as const
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
  /** Host scheduling metadata, separate from untrusted notification payload. */
  lastTriageAttemptAt: timestamp('lastTriageAttemptAt', { withTimezone: true }),
  /** Model response envelope bound to the event and winning attempt, not approval. */
  triageDecision: jsonb('triageDecision').$type<Record<string, unknown>>(),
  /** Bounded, durable wake delivery; the event itself remains the outbox. */
  wakeAttempts: integer('wakeAttempts').notNull().default(0),
  nextWakeAt: timestamp('nextWakeAt', { withTimezone: true }).notNull().defaultNow(),
  wakeLeaseUntil: timestamp('wakeLeaseUntil', { withTimezone: true }),
  wakeLastError: text('wakeLastError'),
  deliveredAt: timestamp('deliveredAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('coordinator_events_pending_idx').on(table.userId, table.deliveredAt, table.createdAt),
  index('coordinator_events_wake_due_idx').on(table.nextWakeAt, table.userId, table.botId)
    .where(sql`${table.deliveredAt} is null and ${table.wakeAttempts} < 8`),
])

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
// External notifications from connected apps, rated by fixed rules or the
// decision model with the attention levels of lib/attention (R-20). Every
// level but `low` is `shown`; hidden rows stay so a repeat delivery is not
// judged again. The Coordinator never writes here.

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
  /** Rows from before the attention levels; new rows leave it null. */
  probability: real('probability'),
  /** critical, high, ask, normal or low (lib/attention/judgment.ts); null on rows from before it. */
  level: text('level').$type<AttentionLevel>(),
  /** The matter it belongs to (ExternalNotification.matterKey). */
  matterKey: text('matterKey'),
  /** The item as an action for the person (R-45), e.g. 「回复 Kevin：…」; the UI falls back to `title` without it. */
  actionTitle: text('actionTitle'),
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

/**
 * A matter from the person's connected apps that reached a routed level
 * (critical, high or ask), and what the Coordinator
 * decided about it (lib/attention/store.ts). Repeated notices about one
 * matter share the row. `state`: `waiting` for a budget or for the matter in
 * hand, `handed` to the Coordinator, then `notified`, `quiet`, `snoozed`
 * (until `runAt`) or `handled` once the person answered.
 */
export const ATTENTION_MATTER_STATES = ['waiting', 'handed', 'notified', 'quiet', 'snoozed', 'handled'] as const
export type AttentionMatterState = (typeof ATTENTION_MATTER_STATES)[number]

export const attentionMatters = pgTable('attention_matters', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  matterKey: text('matterKey').notNull(),
  source: text('source').$type<SuggestionSource>().notNull(),
  /** The latest notice's suggestion row. */
  suggestionId: uuid('suggestionId').references(() => suggestions.id, { onDelete: 'set null' }),
  title: text('title').notNull(), url: text('url'),
  level: text('level').$type<AttentionLevel>().notNull(),
  /** The cost, due window, reversibility and code flag the judgment gave (lib/attention/judgment.ts Assessment). */
  assessment: jsonb('assessment').$type<Record<string, unknown>>().notNull(),
  /** The evidence handed over: the latest notice and its earlier ones. */
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
  state: text('state').$type<AttentionMatterState>().notNull(),
  /** The Coordinator's reason for its latest decision. */
  reason: text('reason'),
  /** When a snoozed matter is handed over again. */
  runAt: timestamp('runAt', { withTimezone: true }),
  /** The next handoff is a recheck of a snooze: it spends no handoff budget. */
  recheck: boolean('recheck').notNull().default(false),
  /** The person asked for the reminder: telling them spends no budget. */
  personAsked: boolean('personAsked').notNull().default(false),
  handoffs: integer('handoffs').notNull().default(0),
  handedAt: timestamp('handedAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('attention_matters_key').on(table.userId, table.matterKey), index('attention_matters_state_idx').on(table.userId, table.state, table.updatedAt)])

/** One person's settings for matters from connected apps; no row means the defaults. */
export const attentionSettings = pgTable('attention_settings', {
  userId: text('userId').primaryKey(),
  /** The person's switch (lib/attention). Off: nothing is handed to the Coordinator; 建议 still fills. */
  enabled: boolean('enabled').notNull().default(true),
  /** The language the person reads 建议 in (zh-CN or en), for the action lines of lib/suggestions/action-title.ts. */
  locale: text('locale'),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/** Where a fact was seen: references only, never the source text. */
export interface UserFactEvidence { source: string; suggestionId?: string; externalId?: string; factIds?: string[]; at: string }

/**
 * One fact in one person's profile (lib/profile), drawn from what reaches them
 * and merged nightly. Facts belong to the person, never to a workspace, and
 * only they see them in 记忆. A fact the person corrected (`userEdited`) is
 * never overwritten by the model. Same fact = same (userId, kind, subjectKey).
 */
export const userFacts = pgTable('user_facts', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  kind: text('kind').$type<UserFactKind>().notNull(),
  /** One line, e.g. 川菜, or Verizon 套餐. */
  subject: text('subject').notNull(),
  /** The subject folded for dedupe (lib/profile/facts.ts subjectKey). */
  subjectKey: text('subjectKey').notNull(),
  /** Structured details: amount, date, time window, place, merchant, items. */
  value: jsonb('value').$type<Record<string, unknown>>().notNull().default({}),
  evidence: jsonb('evidence').$type<UserFactEvidence[]>().notNull().default([]),
  confidence: real('confidence').notNull(),
  firstSeenAt: timestamp('firstSeenAt', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('lastSeenAt', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }),
  state: text('state').$type<UserFactState>().notNull().default('active'),
  userEdited: boolean('userEdited').notNull().default(false),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('user_facts_subject_key').on(table.userId, table.kind, table.subjectKey), index('user_facts_state_idx').on(table.userId, table.state), index('user_facts_kind_idx').on(table.userId, table.kind)])

/** The local date (YYYY-MM-DD) the nightly consolidation last ran for the person (lib/profile/store.ts). The 记忆 switch is userPreferences.memoryEnabled. */
export const userFactConsolidations = pgTable('user_fact_consolidations', {
  userId: text('userId').primaryKey(),
  consolidatedOn: text('consolidatedOn').notNull(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export type ProactiveUsageKind = 'extraction'

/** Proactive model calls and tokens per person, UTC day and kind, for the daily cap (lib/profile/store.ts) and cost per person. */
export const proactiveUsage = pgTable('proactive_usage', {
  userId: text('userId').notNull(),
  day: date('day').notNull(),
  kind: text('kind').$type<ProactiveUsageKind>().notNull(),
  calls: integer('calls').notNull().default(0),
  inputTokens: integer('inputTokens').notNull().default(0),
  outputTokens: integer('outputTokens').notNull().default(0),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.userId, table.day, table.kind] })])

/** Every handoff and decision on a matter; the budgets count `handoff` and `notify` rows (lib/attention/budget.ts). */
export const attentionLog = pgTable('attention_log', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  matterId: uuid('matterId').notNull().references(() => attentionMatters.id, { onDelete: 'cascade' }),
  action: text('action').$type<'handoff' | 'recheck' | 'notify' | 'quiet' | 'snooze' | 'handled'>().notNull(),
  /** Whether it counts against a budget. */
  spends: boolean('spends').notNull(),
  reason: text('reason'),
  runAt: timestamp('runAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('attention_log_budget_idx').on(table.userId, table.action, table.createdAt)])

/** When the person's Composio trigger subscriptions were last checked (lib/suggestions/sources.ts). */
export const suggestionTriggerChecks = pgTable('suggestion_trigger_checks', {
  userId: text('userId').primaryKey(),
  checkedAt: timestamp('checkedAt', { withTimezone: true }).notNull(),
})

/**
 * Per Composio connected account: the provider email read at connect time and
 * whether it is the account bots use for its toolkit (one default per person
 * and toolkit). Tokens stay in Composio.
 */
export const composioAccounts = pgTable('composio_accounts', {
  accountId: text('accountId').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  toolkit: text('toolkit').notNull(),
  email: text('email'),
  /** When the provider gave a final answer on the email (found or not), so it is asked once. */
  emailCheckedAt: timestamp('emailCheckedAt', { withTimezone: true }),
  /** The last try, final or not; a failed try waits about an hour before the next. */
  lastAttemptAt: timestamp('lastAttemptAt', { withTimezone: true }),
  isDefault: boolean('isDefault').notNull().default(false),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('composio_accounts_user_idx').on(table.userId, table.toolkit),
  uniqueIndex('composio_accounts_default_key').on(table.userId, table.toolkit).where(sql`"isDefault"`),
])

/**
 * Each person's IANA time zone, so the daily briefing is written at 08:00
 * their time (app/api/cron/briefings). The browser's zone, sent when the
 * suggestions list loads, replaces any earlier value; the connect callbacks'
 * IP-derived zone only fills a gap.
 */
export const TIME_ZONE_SOURCES = ['auto', 'manual'] as const
export type TimeZoneSource = (typeof TIME_ZONE_SOURCES)[number]

export const userTimeZones = pgTable('user_time_zones', {
  userId: text('userId').primaryKey(),
  timeZone: text('timeZone').notNull(),
  /** 'manual' once the person picked the zone in Settings; reports then only update detectedTimeZone. */
  source: text('source').$type<TimeZoneSource>().notNull().default('auto'),
  /** The zone the browser or IP last reported. */
  detectedTimeZone: text('detectedTimeZone'),
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

/**
 * A message a person sent a running agent, delivered on its next poll.
 * runId is null for personal mailbox messages, which address a mailbox
 * (20261101020100_personal_mailbox_schema.sql); those columns are not listed.
 */
export const runMessages = pgTable('run_messages', {
  id: uuid('id').primaryKey(), runId: uuid('runId').references(() => agentRuns.id, { onDelete: 'cascade' }),
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
  // Optional owner-designated current group agent; never inferred or backfilled.
  leadAgentId: uuid('leadAgentId'),
  leadBotId: uuid('leadBotId'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})
export const conversationMembers = pgTable('conversation_members', {
  conversationId: uuid('conversationId').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  memberType: text('memberType').$type<'user' | 'agent' | 'bot'>().notNull(), memberId: text('memberId').notNull(),
  role: text('role').$type<'owner' | 'member'>().notNull(),
  joinedAt: timestamp('joinedAt', { withTimezone: true }).notNull().defaultNow(), leftAt: timestamp('leftAt', { withTimezone: true }),
}, t => [primaryKey({ columns: [t.conversationId, t.memberType, t.memberId] }), index('conversation_members_identity_idx').on(t.memberType, t.memberId)])
export const conversationMessages = pgTable('conversation_messages', {
  id: uuid('id').primaryKey(), conversationId: uuid('conversationId').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  position: bigint('position', { mode: 'bigint' }).notNull(), authorType: text('authorType').$type<'user' | 'agent' | 'bot'>().notNull(),
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

/** Group execution queue/corrections are scoped through conversation membership. */
export const groupTurns = pgTable('group_turns', {
  messageId: uuid('messageId').primaryKey().references(() => conversationMessages.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversationId').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull(),
  status: text('status').$type<'queued' | 'running' | 'complete' | 'failed'>().notNull().default('queued'),
  agentId: uuid('agentId'), activeRunId: uuid('activeRunId'), route: jsonb('route'), error: text('error'),
  botId: uuid('botId'), modelSelections: jsonb('modelSelections').notNull().default({}),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('group_turns_queue_idx').on(t.conversationId, t.status, t.createdAt)])
export const groupRoutingCorrections = pgTable('group_routing_corrections', {
  messageId: uuid('messageId').primaryKey().references(() => conversationMessages.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversationId').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  message: text('message').notNull(), wrongId: uuid('wrongId').notNull(), rightId: uuid('rightId'), decisionExecution: jsonb('decisionExecution'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('group_routing_corrections_recent_idx').on(t.conversationId, t.createdAt.desc())])
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

// --- Run captures ------------------------------------------------------------
//
// Screenshots and screen recordings a thread keeps as evidence (lib/captures).
// Binary, immutable and unversioned, so they are not artifacts: a capture is
// one file in the artifacts bucket under `storageKey`, bound to its run.

export const RUN_CAPTURE_STATUSES = ['recording', 'uploading', 'ready', 'failed'] as const
export type RunCaptureStatus = (typeof RUN_CAPTURE_STATUSES)[number]

export const runCaptures = pgTable('run_captures', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  runId: uuid('runId').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  issueId: uuid('issueId').references(() => issues.id, { onDelete: 'set null' }),
  botId: uuid('botId').references(() => bots.id, { onDelete: 'set null' }),
  kind: text('kind').$type<CaptureKind>().notNull(),
  contentType: text('contentType').$type<CaptureContentType>().notNull(),
  source: text('source').$type<CaptureSource>().notNull(),
  status: text('status').$type<RunCaptureStatus>().notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  /** Object key in the artifacts bucket; set once the file is there. */
  storageKey: text('storageKey'),
  /** The file itself, only where no bucket is configured (previews, tests); production always uses R2. */
  inlineContent: bytea('inlineContent'),
  /** Declared by the uploader until the file is ready, then measured. */
  size: integer('size'), sha256: text('sha256'),
  durationMs: integer('durationMs'),
  /** A cloud computer recording: the desktop it records and when it stops by itself. */
  display: integer('display'),
  expiresAt: timestamp('expiresAt', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('run_captures_run_idx').on(table.runId, table.createdAt),
  index('run_captures_user_idx').on(table.userId, table.createdAt),
  uniqueIndex('run_captures_recording_key').on(table.runId).where(sql`${table.status} = 'recording'`),
])

/** A link anyone can open, as `artifact_shares`: only the token's hash is stored; revoking ends it. */
export const runCaptureShares = pgTable('run_capture_shares', {
  id: uuid('id').primaryKey(),
  captureId: uuid('captureId').notNull().references(() => runCaptures.id, { onDelete: 'cascade' }),
  tokenHash: text('tokenHash').notNull(), createdBy: text('createdBy').notNull(),
  revokedAt: timestamp('revokedAt', { withTimezone: true }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('run_capture_shares_token_key').on(table.tokenHash), index('run_capture_shares_capture_idx').on(table.captureId)])
/**
 * Something an agent does in the person's own accounts (send an email,
 * create or change a calendar event, or an agent-run write). A write the
 * connection and policy allow is inserted `running` with no `decidedAt` and
 * stays as the record. One that needs approval stays `pending` until the
 * person approves or declines it; approving runs exactly `input`
 * (lib/pending-actions.ts).
 * `context` is what the card shows besides the input, such as the event being changed.
 */
export const PENDING_ACTION_STATUSES = ['pending', 'running', 'done', 'failed', 'declined'] as const
export type PendingActionStatus = (typeof PENDING_ACTION_STATUSES)[number]
export const pendingActions = pgTable('pending_actions', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  action: text('action').notNull(),
  connectedAccountId: text('connectedAccountId'),
  input: jsonb('input').$type<Record<string, unknown>>().notNull(),
  context: jsonb('context').$type<Record<string, unknown> | null>(),
  status: text('status').$type<PendingActionStatus>().notNull().default('pending'),
  result: jsonb('result').$type<Record<string, unknown> | null>(), error: text('error'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decidedAt', { withTimezone: true }),
}, table => [index('pending_actions_user_status_idx').on(table.userId, table.status, table.createdAt)])

// Factory #192 uses existing issues, Coordinator events and Harness runs.
export const factoryTasks = pgTable('factory_tasks', {
  id: uuid('id').primaryKey(), userId: text('userId').notNull(),
  botId: uuid('botId'),
  issueId: uuid('issueId').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  scopeVersion: integer('scopeVersion'),
  sourceEventId: uuid('sourceEventId').notNull(),
  route: jsonb('route').$type<import('../factory/contract').FactoryRoute>().notNull(),
  stage: text('stage').$type<import('../factory/contract').FactoryStage>().notNull(),
  status: text('status').$type<import('../factory/contract').FactoryStatus>().notNull(),
  revision: integer('revision').notNull().default(1), attemptId: uuid('attemptId').notNull(), candidateId: uuid('candidateId'),
  reason: text('reason').notNull(), createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('factory_tasks_source_key').on(table.userId, table.issueId, table.sourceEventId), index('factory_tasks_owner_issue_idx').on(table.userId, table.issueId, table.updatedAt)])

export const factoryCandidates = pgTable('factory_candidates', {
  previewDatabaseBranch: text('previewDatabaseBranch'), machineName: text('machineName'),
  id: uuid('id').primaryKey(), taskId: uuid('taskId').notNull().references(() => factoryTasks.id, { onDelete: 'cascade' }),
  sha: text('sha').notNull(), repository: text('repository').notNull(), environment: text('environment').notNull(), scope: text('scope').notNull(),
  runId: uuid('runId').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('factory_candidates_task_id_key').on(table.taskId, table.id)])

export const factoryAttempts = pgTable('factory_attempts', {
  id: uuid('id').primaryKey(), taskId: uuid('taskId').notNull().references(() => factoryTasks.id, { onDelete: 'cascade' }),
  stage: text('stage').$type<import('../factory/contract').FactoryStage>().notNull(), ordinal: integer('ordinal').notNull(), position: integer('position').notNull(),
  status: text('status').$type<import('../factory/contract').FactoryStatus>().notNull(), candidateId: uuid('candidateId'),
  runId: uuid('runId'), sessionId: text('sessionId'), reason: text('reason').notNull(),
  output: jsonb('output').$type<Record<string, unknown>>().notNull().default({}),
  evidence: jsonb('evidence').$type<import('../factory/contract').FactoryEvidence[]>().notNull().default([]),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(), finishedAt: timestamp('finishedAt', { withTimezone: true }),
}, table => [unique('factory_attempts_task_stage_ordinal_key').on(table.taskId, table.stage, table.ordinal), unique('factory_attempts_task_position_key').on(table.taskId, table.position), unique('factory_attempts_task_id_key').on(table.taskId, table.id), uniqueIndex('factory_attempts_one_run_key').on(table.runId).where(sql`${table.runId} IS NOT NULL`), index('factory_attempts_run_idx').on(table.runId)])

export const factoryEvents = pgTable('factory_events', {
  taskId: uuid('taskId').notNull().references(() => factoryTasks.id, { onDelete: 'cascade' }), eventId: uuid('eventId').notNull(),
  request: jsonb('request').$type<Record<string, unknown>>().notNull(), result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.taskId, table.eventId] })])
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

/** One Expo push token per installed copy of the iOS app (apps/mobile); removed on sign-out. */
export const mobilePushTokens = pgTable('mobile_push_tokens', {
  id: uuid('id').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  platform: text('platform').notNull(),
  deviceName: text('deviceName'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('mobile_push_tokens_token_key').on(table.token), index('mobile_push_tokens_user_idx').on(table.userId)])

export const PUSH_WHEN = ['always', 'away'] as const
export type PushWhen = (typeof PUSH_WHEN)[number]
export type { SendKey } from '../send-key'

/**
 * The app's 通知 and 记忆 settings (docs/design/mobile.md). The push flags pick
 * which of the Coordinator's own messages reach the phone; 主动消息 itself is
 * attention_settings.enabled. No row means the defaults.
 */
export const userPreferences = pgTable('user_preferences', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  pushDecide: boolean('pushDecide').notNull().default(true),
  pushReview: boolean('pushReview').notNull().default(true),
  pushFinished: boolean('pushFinished').notNull().default(true),
  pushBriefing: boolean('pushBriefing').notNull().default(true),
  pushWhen: text('pushWhen').$type<PushWhen>().notNull().default('always'),
  memoryEnabled: boolean('memoryEnabled').notNull().default(true),
  /** The chat composer's send key: Enter (Shift+Enter breaks the line) or ⌘/Ctrl+Enter (Enter breaks the line). */
  sendKey: text('sendKey').$type<SendKey>().notNull().default('enter'),
  /** The person's own instructions for the Coordinator and their Bots, at most 2000 characters. */
  personalInstructions: text('personalInstructions').notNull().default(''),
  /** 每日建议: the 08:00 briefing. Needs memoryEnabled. */
  dailySuggestions: boolean('dailySuggestions').notNull().default(true),
  /** Composio app id -> false for each app turned off as a suggestions source; a missing app is on. */
  suggestionSources: jsonb('suggestionSources').$type<Record<string, boolean>>().notNull().default({}),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A picture the person uploaded for their profile (lib/account/avatar.ts).
 * `user.image` points at /api/avatars/<userId>/<sha256>; the bytes live in R2
 * under `storageKey`, or in `inlineContent` where no bucket is configured.
 */
export const userAvatars = pgTable('user_avatars', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  sha256: text('sha256').notNull(),
  contentType: text('contentType').$type<'image/png' | 'image/jpeg' | 'image/webp'>().notNull(),
  size: integer('size').notNull(),
  storageKey: text('storageKey'),
  inlineContent: bytea('inlineContent'),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * 「导出我的数据」: one emailed download link. Only the token's hash is kept;
 * the file is built when its owner opens the link (lib/account/export.ts).
 */
export const accountDataExports = pgTable('account_data_exports', {
  id: uuid('id').primaryKey(),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('tokenHash').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  downloadedAt: timestamp('downloadedAt', { withTimezone: true }),
}, table => [uniqueIndex('account_data_exports_token_key').on(table.tokenHash), index('account_data_exports_user_created_idx').on(table.userId, table.createdAt)])
export const WORKSPACE_BOT_MODELS = ['mikka', 'codex', 'claude'] as const
export type WorkspaceBotModel = (typeof WORKSPACE_BOT_MODELS)[number]

/** Workspace-level defaults and usage limits (settings › Bots, Usage). Null means unset / unlimited. */
export const workspaceSettings = pgTable('workspace_settings', {
  workspaceId: uuid('workspaceId').primaryKey(),
  defaultModel: text('defaultModel').$type<WorkspaceBotModel | null>(),
  defaultRepository: text('defaultRepository'),
  monthlyCreditLimit: integer('monthlyCreditLimit'),
  botMonthlyCreditLimit: integer('botMonthlyCreditLimit'),
  backgroundDailyCreditLimit: integer('backgroundDailyCreditLimit'),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/** Stripe subscription state for a workspace, written by the billing webhook. */
export const workspaceBilling = pgTable('workspace_billing', {
  workspaceId: uuid('workspaceId').primaryKey(),
  stripeCustomerId: text('stripeCustomerId').unique(),
  stripeSubscriptionId: text('stripeSubscriptionId').unique(),
  plan: text('plan'),
  status: text('status'),
  seats: integer('seats').notNull().default(0),
  currentPeriodEnd: timestamp('currentPeriodEnd', { withTimezone: true }),
  autoRechargeEnabled: boolean('autoRechargeEnabled').notNull().default(false),
  autoRechargeThreshold: integer('autoRechargeThreshold'),
  autoRechargePacks: integer('autoRechargePacks'),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/** Credit grants: 'plan' per paid invoice (replaces the previous period's), 'purchased' never expires. */
export const workspaceCreditGrants = pgTable('workspace_credit_grants', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspaceId').notNull(),
  bucket: text('bucket').$type<'plan' | 'purchased'>().notNull(),
  points: integer('points').notNull(),
  reason: text('reason').notNull(),
  externalId: text('externalId').notNull().unique(),
  stripePaymentIntentId: text('stripePaymentIntentId'),
  amountCents: integer('amountCents'),
  currency: text('currency'),
  receiptUrl: text('receiptUrl'),
  stripeFeeCents: integer('stripeFeeCents'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('workspace_credit_grants_workspace_idx').on(table.workspaceId, table.createdAt), index('workspace_credit_grants_payment_intent_idx').on(table.stripePaymentIntentId)])

export const stripeWebhookEvents = pgTable('stripe_webhook_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  processedAt: timestamp('processedAt', { withTimezone: true }).notNull().defaultNow(),
})
