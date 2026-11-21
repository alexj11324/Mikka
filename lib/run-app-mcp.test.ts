import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizeRunApp, runAppCall, runAppTool } from './run-app-mcp'

const now = Date.parse('2026-10-31T12:00:00Z')
const live = { token: 'mkw_owner', expiresAt: now / 1000 + 600, extra: { userId: 'owner', runId: 'run-1', botId: 'bot-1' } }
const connected: Record<string, string[]> = { owner: ['gmail', 'notion'], other: ['figma'] }
const allowed = async (userId: string) => connected[userId] ?? []

test('the token names owner, Bot and run; the request names only the toolkit', async () => {
  const seen: unknown[] = []
  const scope = await authorizeRunApp(live, 'gmail', async (userId, botId) => { seen.push([userId, botId]); return allowed(userId) }, now)
  assert.deepEqual(scope, { userId: 'owner', botId: 'bot-1', runId: 'run-1', toolkit: 'gmail' })
  assert.deepEqual(seen, [['owner', 'bot-1']])
})

test('another person\'s app is refused: the owner always comes from the token', async () => {
  assert.equal(await authorizeRunApp(live, 'figma', allowed, now), null)
  assert.deepEqual(await authorizeRunApp({ ...live, extra: { ...live.extra, userId: 'other' } }, 'figma', allowed, now), { userId: 'other', botId: 'bot-1', runId: 'run-1', toolkit: 'figma' })
})

test('a toolkit outside the run\'s list or a malformed one is refused', async () => {
  assert.equal(await authorizeRunApp(live, 'slack', allowed, now), null)
  assert.equal(await authorizeRunApp(live, 'Gmail', allowed, now), null)
  assert.equal(await authorizeRunApp(live, '../gmail', allowed, now), null)
})

test('an expired, missing or non-run token is refused', async () => {
  assert.equal(await authorizeRunApp({ ...live, expiresAt: now / 1000 }, 'gmail', allowed, now), null)
  assert.equal(await authorizeRunApp({ ...live, expiresAt: undefined }, 'gmail', allowed, now), null)
  assert.equal(await authorizeRunApp(undefined, 'gmail', allowed, now), null)
  assert.equal(await authorizeRunApp({ ...live, token: 'oauth_token' }, 'gmail', allowed, now), null)
  assert.equal(await authorizeRunApp({ ...live, extra: { runId: 'run-1' } }, 'gmail', allowed, now), null)
})

test('only a toolkit\'s own tools with object schemas are listed', () => {
  const listed = runAppTool({ slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch', description: 'Fetch\n mail', tags: ['readOnlyHint'], toolkit: { slug: 'gmail' }, inputParameters: { type: 'object', properties: {} } }, 'gmail')!
  assert.equal(listed.name, 'GMAIL_FETCH_EMAILS')
  assert.equal(listed.description, 'Fetch mail')
  assert.equal(listed.readOnly, true)
  const selection = listed.inputSchema.properties.mikka_account_id as { type: string; description: string }
  assert.equal(selection.type, 'string')
  assert.match(selection.description, /accounts list.*integrationAccountSelectionRequired/)
  assert.equal(runAppTool({ slug: 'SLACK_SEND', name: 'Send', toolkit: { slug: 'slack' } }, 'gmail'), null)
  assert.equal(runAppTool({ slug: 'SLACK_SEND', name: 'Send', toolkit: { slug: 'gmail' } }, 'gmail'), null)
  assert.equal(runAppTool({ slug: 'GMAIL_X', name: 'X', toolkit: { slug: 'gmail' }, inputParameters: { type: 'string' } }, 'gmail'), null)
})

test('native account metadata is stripped while the provider account_id remains a business argument', () => {
  const tool = { slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch', toolkit: { slug: 'gmail' } }
  assert.deepEqual(runAppCall(tool, 'gmail', { account_id: 'business-record', mikka_account_id: 'selected-connection' }), {
    toolkit: 'gmail', tool: tool.slug, account_id: 'selected-connection', arguments: { account_id: 'business-record' },
  })
  for (const value of ['', 7, null, 'x'.repeat(256)]) assert.equal(runAppCall(tool, 'gmail', { mikka_account_id: value }), null)
})

test('a colliding provider field gets an explicit envelope and is never silently overwritten', () => {
  const input = { type: 'object', properties: { mikka_account_id: { type: 'string', description: 'Business record' } }, required: ['mikka_account_id'], additionalProperties: false }
  const tool = { slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch', toolkit: { slug: 'gmail' }, inputParameters: input }
  const listed = runAppTool(tool, 'gmail')!
  assert.deepEqual(listed.inputSchema.properties.arguments, input)
  assert.deepEqual(listed.inputSchema.required, ['arguments'])
  assert.match(listed.description, /business inputs are under arguments/)
  assert.deepEqual(runAppCall(tool, 'gmail', { mikka_account_id: 'selected-connection', arguments: { mikka_account_id: 'business-record' } }), {
    toolkit: 'gmail', tool: tool.slug, account_id: 'selected-connection', arguments: { mikka_account_id: 'business-record' },
  })
  assert.equal(runAppCall(tool, 'gmail', { mikka_account_id: 'selected-connection', business: 'invalid' }), null)
})
