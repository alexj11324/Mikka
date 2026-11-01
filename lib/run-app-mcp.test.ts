import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizeRunApp, runAppTool } from './run-app-mcp'

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
  assert.deepEqual(runAppTool({ slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch', description: 'Fetch\n mail', tags: ['readOnlyHint'], toolkit: { slug: 'gmail' }, inputParameters: { type: 'object', properties: {} } }, 'gmail'),
    { name: 'GMAIL_FETCH_EMAILS', description: 'Fetch mail', inputSchema: { type: 'object', properties: {} }, readOnly: true })
  assert.equal(runAppTool({ slug: 'SLACK_SEND', name: 'Send', toolkit: { slug: 'slack' } }, 'gmail'), null)
  assert.equal(runAppTool({ slug: 'SLACK_SEND', name: 'Send', toolkit: { slug: 'gmail' } }, 'gmail'), null)
  assert.equal(runAppTool({ slug: 'GMAIL_X', name: 'X', toolkit: { slug: 'gmail' }, inputParameters: { type: 'string' } }, 'gmail'), null)
})
