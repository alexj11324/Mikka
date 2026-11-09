import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mock, test } from 'node:test'
import { drizzle } from 'drizzle-orm/pg-proxy'
import { sql } from 'drizzle-orm'
import { actingContext } from '@/lib/activity-actor'
import { mergeChat } from './chat-poll'
import type { ChatView } from './store'

const owner = 'projection-version-owner'
const botId = '70000000-0000-4000-8000-000000000001'
const workspaceId = '70000000-0000-4000-8000-000000000002'
const otherWorkspaceId = '70000000-0000-4000-8000-000000000003'
const botRead = 'select "workspaceId" from "bots" where ("bots"."id" = $1 and "bots"."ownerId" = $2) limit $3'
const prefixHash = 'a'.repeat(32)
const storedHash = 'b'.repeat(32)
const createdAt = '2026-11-08T00:00:00.000Z'
const messages = [
  { id: 'row-1', position: 1, message: { role: 'user', content: 'First question' }, createdAt },
  { id: 'row-2', position: 2, message: { role: 'assistant', content: '', mikkaStopped: true, mikkaStreamId: 'stopped:0' }, createdAt },
  { id: 'row-3', position: 3, message: { role: 'user', content: 'Next question' }, createdAt },
  { id: 'row-4', position: 4, message: { role: 'assistant', content: 'Latest reply', mikkaStreamId: 'latest:0' }, createdAt },
]
const reads: string[] = []
const workspaceReads: string[] = []
let membershipActive = true

// PostgreSQL's pre-projection aggregates are opaque fixtures. The real store
// builds/executes its Drizzle reads and makes the version/continuation decision;
// this adapter neither implements nor imports the new projection hash.
const database = drizzle(async (query, params) => {
  reads.push(query)
  if (query === botRead) {
    assert.deepEqual(params, [botId, owner, 1])
    return { rows: [[workspaceId]] }
  }
  if (query.includes('"chat_prefix"')) {
    return { rows: [query.includes("jsonb_agg(jsonb_build_object('position'") ? [prefixHash, []] : [prefixHash]] }
  }
  if (query.includes('"chat_messages"')) {
    const after = query.match(/"coordinator_messages"\."position" > \$(\d+)/)
    const rows = messages.filter(row => !after || row.position > Number(params[Number(after[1]) - 1])).toReversed()
    return { rows: [[null, null, null, null, null, rows, []]] }
  }
  if (query.includes('"latest"')) {
    return { rows: [[null, null, null, null, null, 4, storedHash, 'assistant', 'latest:0', createdAt, []]] }
  }
  throw new Error('unexpected_projection_version_query')
})

const unused = () => { throw new Error('unexpected_projection_version_dependency') }
mock.module('@/lib/db', { namedExports: { db: database } })
// Run the real task-workspace guard against a separate, strict WS executor.
// This fixture must not authorize a chat from its APP Bot row alone.
const workspaceDatabase = drizzle(async (query, params) => {
  workspaceReads.push(query)
  assert.equal(query, 'select "mikka_workspaces"."id", "mikka_workspaces"."kind" from "mikka_workspaces" inner join "mikka_workspace_members" on "mikka_workspace_members"."workspaceId" = "mikka_workspaces"."id" where ("mikka_workspace_members"."userId" = $1 and "mikka_workspace_members"."status" = $2 and "mikka_workspaces"."id" = $3 and ("mikka_workspaces"."kind" = $4 or ("mikka_workspaces"."kind" = $5 and "mikka_workspaces"."userId" = $6))) order by "mikka_workspaces"."createdAt" asc')
  assert.deepEqual(params, [owner, 'active', workspaceId, 'team', 'personal', owner])
  return { rows: membershipActive ? [[workspaceId, 'team']] : [] }
})
mock.module('@/lib/workspace-db', { namedExports: { workspaceDb: workspaceDatabase, workspacePool: { query: unused, connect: unused } } })
for (const [path, exports] of [
  ['./run-completion-observation', { runCompletionObservations: unused }],
  ['@/lib/agent-runs', { visibleRuns: unused }],
  ['@/lib/run-bot-name', { threadNamePrompt: sql`''` }],
  ['@/lib/credentials/chat-guard', { assertCredentialSafeChat: unused }],
  ['@/lib/issues-for-user', { issuesForUser: unused }],
  ['@/lib/issue-visibility', { issueVisibility: unused }],
  ['@/lib/live/coordinator-session', { coordinatorSessionChanged: unused }],
  ['@/lib/workflow-wake', { wakeTokens: unused, wakeWorkflowAfterCommit: unused }],
  ['./wake-after-commit', { wakeCoordinatorSoon: unused }],
  ['@/lib/db/listen', { COORDINATOR_LEASE_CHANNEL: 'test-coordinator-lease' }],
  ['./telegram-pending', { markTelegramPending: unused, pendingTelegramTargets: unused }],
  ['./triage', { eventsForInbox: unused, isolateTaskRequest: unused }],
  ['@/lib/task-identifier-server', { taskIdentifiers: unused }],
  ['@/lib/artifacts/store', { artifactSummaries: async () => ({}) }],
  ['@/lib/preferences', { readPreferences: unused, readCoordinatorPromptPreferences: unused }],
  ['./triage-batch', { TRIAGE_RETRY_COOLDOWN_MS: 60_000 }],
  ['@/lib/schedules/store', { scheduledInbox: unused }],
  ['../live/chats', { botChatChanged: unused }],
] as const) mock.module(path, { namedExports: exports })

const store = await import('./store')

test('unchanged rows invalidate the pre-projection chat version while current reads remain stable', async () => {
  // Persisted clients used this exact v0 protocol before a projection version
  // existed; do not derive the expected current hash in this test.
  const legacyVersion = createHash('sha256').update(`200|${storedHash}||`).digest('hex').slice(0, 32)
  const current = await store.chatVersionState(owner, 200, botId)
  assert.notEqual(current.version, legacyVersion, 'an old known version must trigger a body read')
  assert.equal((await store.chatVersionState(owner, 200, botId)).version, current.version)
})

for (const restoreToolMetadata of [false, true]) {
  test(`a legacy ${restoreToolMetadata ? 'metadata' : 'ordinary'} prefix rebuilds the cached stopped reply`, async () => {
    const full = await store.chatView(owner, 200, botId)
    const stale: ChatView = { ...full, items: full.items.map(item => {
      if (item.position !== 2) return item
      const { streamId: _streamId, ...oldItem } = item
      return oldItem
    }), continuation: { after: 3, cursor: 4, prefix: prefixHash } }
    const repaired = await store.chatUpdate(owner, botId, { ...stale.continuation!,
      ...(restoreToolMetadata ? { restoreToolMetadata: true as const } : {}) })
    assert.equal('after' in repaired, false, 'a v0 proof must not retain the old projected prefix')
    const merged = mergeChat(stale, repaired)
    assert.ok(merged)
    assert.equal(merged.items.find(item => item.position === 2)?.streamId, 'stopped:0')
    assert.equal(merged.items.find(item => item.position === 2)?.stopped, true)
  })

  test(`a current ${restoreToolMetadata ? 'metadata' : 'ordinary'} prefix still reads only the tail`, async () => {
    const full = await store.chatView(owner, 200, botId)
    const before = reads.length
    const update = await store.chatUpdate(owner, botId, { ...full.continuation!,
      ...(restoreToolMetadata ? { restoreToolMetadata: true as const } : {}) })
    assert.equal('after' in update, true, 'the two prefix readers must agree on the current projection')
    assert.equal('after' in update && update.after, full.continuation!.after)
    assert.deepEqual(update.items.map(item => item.position), [4])
    assert.ok(reads.slice(before).some(query => /"coordinator_messages"\."position" > \$\d+/.test(query)))
    if (restoreToolMetadata) assert.equal('toolMetadata' in update && update.toolMetadata?.prefix, full.continuation!.prefix)
  })
}

test('revoking membership rejects fresh chat body and version reads before projection', async () => {
  await store.chatView(owner, 200, botId)
  const before = reads.length
  const beforeWorkspace = workspaceReads.length
  membershipActive = false
  try {
    await assert.rejects(store.chatView(owner, 200, botId), { name: 'ActionFailureError', code: 'workspaceAccessDenied' })
    await assert.rejects(store.chatVersionState(owner, 200, botId), { name: 'ActionFailureError', code: 'workspaceAccessDenied' })
    assert.deepEqual(reads.slice(before), [botRead, botRead], 'no chat body, prefix or version aggregate is read after revocation')
    assert.equal(workspaceReads.length - beforeWorkspace, 2, 'each operation checks current membership')
  } finally {
    membershipActive = true
  }
})

test('a token pinned to another workspace cannot read this Bot chat projection', async () => {
  const before = reads.length
  const beforeWorkspace = workspaceReads.length
  await actingContext.run({ userId: owner, tokenWorkspaceId: otherWorkspaceId }, async () => {
    await assert.rejects(store.chatView(owner, 200, botId), { name: 'ActionFailureError', code: 'workspaceAccessDenied' })
    await assert.rejects(store.chatVersionState(owner, 200, botId), { name: 'ActionFailureError', code: 'workspaceAccessDenied' })
  })
  assert.deepEqual(reads.slice(before), [botRead, botRead])
  assert.equal(workspaceReads.length, beforeWorkspace, 'a mismatched token scope cannot fall back to ordinary membership')
})
