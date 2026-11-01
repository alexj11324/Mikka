import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

// The hourly backfill against stubbed Composio and storage: one person's revoked
// provider token must not fail the run or stop the people after them.
const NOTION_401 = '{"object":"error","status":401,"code":"unauthorized","message":"API token is invalid.","additional_data":{"reason":"token_invalid"}}'
const people = ['person-revoked', 'person-ok']
let failure: (userId: string) => string | null = () => null
const ingested: unknown[][] = []
const page = (id: string) => ({ object: 'page', id, url: `https://www.notion.so/${id}`, last_edited_time: new Date().toISOString(), properties: { title: { type: 'title', title: [{ plain_text: 'Plan' }] } } })

let reconcile: typeof import('./reconcile')
before(async () => {
  mock.module('@/lib/linear-sync/flags', { namedExports: { linearSyncEnabled: async () => false } })
  mock.module('./github-redelivery', { namedExports: { redeliverFailedGitHubWebhooks: async () => null } })
  mock.module('./sources', { namedExports: { ensureComposioTriggers: async () => undefined, linearWebhookNotifications: async () => [] } })
  mock.module('./store', { namedExports: { ingestNotifications: async (notifications: unknown[]) => { ingested.push(notifications) } } })
  // Two selects: the people to backfill, then (per person with pages) the suggestions already on file.
  mock.module('@/lib/db', { namedExports: { db: { select: () => ({ from: () => ({
    orderBy: async () => people.map(userId => ({ userId })),
    where: async () => [],
  }) }) }, pool: null } })
  mock.module('@/lib/composio', { namedExports: {
    getComposio: () => ({ connectedAccounts: { list: async ({ userIds }: { userIds: string[] }) => ({ items: [{ id: `acct-${userIds[0]}`, status: 'ACTIVE', isDisabled: false, toolkit: { slug: 'notion' } }], nextCursor: null }) } }),
    runComposioAction: async (userId: string) => {
      const error = failure(userId)
      return error ? { error } : { data: { results: [page(`${userId}-page`)] }, accountId: `acct-${userId}` }
    },
  } })
  reconcile = await import('./reconcile')
})
beforeEach(() => { ingested.length = 0; failure = () => null })

test('a revoked provider token skips that person as needing reconnecting; the run goes on and does not fail', async () => {
  failure = userId => userId === 'person-revoked' ? NOTION_401 : null
  const warnings = mock.method(console, 'warn', () => {})
  const errors = mock.method(console, 'error', () => {})
  try {
    const result = await reconcile.reconcileSuggestions()
    assert.equal(result.people, 2)
    assert.deepEqual(result.failed, {}, 'not a failed run')
    assert.deepEqual(result.reconnect, { notion: 1 })
    assert.equal(result.read.notion, 1, 'the next person is still read')
    assert.equal(errors.mock.callCount(), 0)
    // The provider's answer concerns the person's credentials and is not logged.
    assert.ok(warnings.mock.calls.every(call => !JSON.stringify(call.arguments).includes('API token is invalid')))
  } finally { warnings.mock.restore(); errors.mock.restore() }
})

test('any other provider failure is still a failed read', async () => {
  failure = userId => userId === 'person-revoked' ? '{"object":"error","status":502,"code":"service_unavailable"}' : null
  const errors = mock.method(console, 'error', () => {})
  try {
    const result = await reconcile.reconcileSuggestions()
    assert.deepEqual(result.failed, { notion: 1 })
    assert.deepEqual(result.reconnect, {})
    assert.equal(result.read.notion, 1)
  } finally { errors.mock.restore() }
})

test('needsReconnect recognises refused authorization only', () => {
  for (const message of [NOTION_401, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}', 'Request failed with status code 401: Unauthorized', 'invalid_token'])
    assert.equal(reconcile.needsReconnect(message), true, message)
  for (const message of ['{"status":500,"code":"internal_server_error"}', 'fetch failed', 'integrationActionFailed', 'rate_limited', '{"status":429}'])
    assert.equal(reconcile.needsReconnect(message), false, message)
})
