import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

let enabled = false
let reads = 0
const unexpected = () => { throw new Error('No provider, notification or briefing work should start') }
let sources: typeof import('../suggestions/sources')
let reconcile: typeof import('../suggestions/reconcile')

before(async () => {
  mock.module('./flags', { namedExports: { linearSyncEnabled: async () => enabled } })
  mock.module('@/lib/db', { namedExports: {
    db: { select: () => {
      reads++
      return { from: () => ({ where: () => {
        const result: unknown[] = []
        return Object.assign(Promise.resolve(result), { limit: async () => result })
      } }) }
    } }, pool: { query: unexpected },
  } })
  mock.module('@/lib/composio', { namedExports: { getComposio: () => null, runComposioAction: unexpected } })
  mock.module('./tokens', { namedExports: { linearAccessToken: unexpected } })
  mock.module('./graphql', { namedExports: { linearGraphQL: unexpected } })
  mock.module('../suggestions/store', { namedExports: { ingestNotifications: unexpected, recordTimeZone: unexpected, writeFirstBriefing: unexpected } })
  mock.module('../suggestions/github-redelivery', { namedExports: { redeliverFailedGitHubWebhooks: async () => null } })
  sources = await import('../suggestions/sources')
  reconcile = await import('../suggestions/reconcile')
})

test('paused Linear notification, delayed connection briefing and hourly recovery do no Linear reads', async () => {
  enabled = false; reads = 0
  assert.deepEqual(await sources.linearWebhookNotifications('org', { type: 'Issue' }), [])
  assert.deepEqual(await sources.linearWebhookNotifications('org', { type: 'Comment', data: { issueId: 'issue' } }), [])
  await sources.bootstrapSuggestions('user', 'linear', null)
  const result = await reconcile.reconcileSuggestions()
  assert.deepEqual(result.linear, { deliveries: 0, notifications: 0 })
  assert.equal(reads, 0)
})

test('re-enabled recovery and notifications read again, and a later pause stops them', async () => {
  enabled = true; reads = 0
  assert.deepEqual(await sources.linearWebhookNotifications('org', { type: 'Issue' }), [])
  await reconcile.reconcileSuggestions()
  assert.equal(reads, 2)
  enabled = false
  await sources.linearWebhookNotifications('org', { type: 'Issue' })
  await reconcile.reconcileSuggestions()
  assert.equal(reads, 2)
})
