import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mock, test } from 'node:test'
import { drizzle } from 'drizzle-orm/pg-proxy'
import { sql } from 'drizzle-orm'
import { mergeChat } from './chat-poll'
import type { ChatView } from './store'

const owner = 'projection-version-owner'
const botId = '70000000-0000-4000-8000-000000000001'
const workspaceId = '70000000-0000-4000-8000-000000000002'
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

// PostgreSQL's pre-projection aggregates are opaque fixtures. The real store
// builds/executes its Drizzle reads and makes the version/continuation decision;
// this adapter neither implements nor imports the new projection hash.
const database = drizzle(async (query, params) => {
  reads.push(query)
  if (query.startsWith('select "workspaceId" from "bots"')) {
    assert.deepEqual(params, [botId, owner, 1])
    return { rows: [[workspaceId]] }
  }
  if (query.includes('"chat_prefix"')) {
    return { rows: [query.includes("jsonb_agg(jsonb_build_object('position'") ? [prefixHash, []] : [prefixHash]] }
  }
  if (query.includes('"chat_messages"')) {
    const after = query.match(/"coordinator_messages"\."position" > \$(\d+)/)
    const rows = messages.filter(row => !after || row.position > Number(params[Number(after[1]) - 1])).toReversed()
    // Column order follows the store's select: five session lease fields, then
    // the fold summary and its cursor, then the rows and the waiting inbox.
    return { rows: [[null, null, null, null, null, null, null, rows, []]] }
  }
  if (query.includes('"latest"')) {
    return { rows: [[null, null, null, null, null, 4, storedHash, 'assistant', 'latest:0', createdAt, []]] }
  }
  throw new Error('unexpected_projection_version_query')
})

const unused = () => { throw new Error('unexpected_projection_version_dependency') }
mock.module('@/lib/db', { namedExports: { db: database, pool: { query: unused, connect: unused } } })
// Keep the real chatReader and tenant check; this transport models only this
// owner's active Personal Workspace, alongside the existing opaque chat rows.
const expectedMembershipSql = "select \"mikka_workspaces\".\"id\", \"mikka_workspaces\".\"kind\", \"mikka_organization_workspaces\".\"organizationId\" from \"mikka_workspaces\" inner join \"mikka_workspace_members\" on \"mikka_workspace_members\".\"workspaceId\" = \"mikka_workspaces\".\"id\" left join \"mikka_organization_workspaces\" on \"mikka_organization_workspaces\".\"workspaceId\" = \"mikka_workspaces\".\"id\" where (\"mikka_workspace_members\".\"userId\" = $1 and \"mikka_workspace_members\".\"status\" = $2 and \"mikka_workspaces\".\"id\" = $3 and (\"mikka_workspaces\".\"kind\" = $4 or (\"mikka_workspaces\".\"kind\" = $5 and \"mikka_workspaces\".\"userId\" = $6))) order by \"mikka_workspaces\".\"createdAt\" asc"
const workspaceDatabase = drizzle(async (query, params) => {
  let actualSql = query
  // This is the real Drizzle transport SQL: only fixed aliases are expanded,
  // then every base table, column, JOIN and owner/tenant predicate is checked.
  for (const [table, name] of [['mikka_workspaces', 'w'], ['mikka_workspace_members', 'm'], ['mikka_organization_workspaces', 'o']]) {
    actualSql = actualSql.replaceAll('"' + table + '" "' + name + '"', '"' + table + '"')
      .replaceAll('"' + name + '".', '"' + table + '".')
  }
  assert.equal(actualSql, expectedMembershipSql)
  assert.deepEqual(params, [owner, 'active', workspaceId, 'team', 'personal', owner])
  return { rows: [[workspaceId, 'personal', null]] }
})
mock.module('@/lib/workspace-db', { namedExports: { workspaceDb: workspaceDatabase } })
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
