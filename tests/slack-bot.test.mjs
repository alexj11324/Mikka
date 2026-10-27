import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const seen = new Set()
let lock
const state = {
  async setIfNotExists(key) { if (seen.has(key)) return false; seen.add(key); return true },
  async acquireLock(threadId) { if (lock) return null; return lock = { threadId, token: 'test', expiresAt: Date.now() + 60_000 } },
  async releaseLock() { lock = undefined },
}
mock.module('@chat-adapter/state-pg', { namedExports: { createPostgresState: () => state } })
mock.module(new URL('../lib/db/index.ts', import.meta.url).href, { namedExports: { pool: null } })
mock.module(new URL('../workflows/slack/workflow.ts', import.meta.url).href, { namedExports: { slackTurn() {} } })
let releaseFirst, signalStarted
const held = new Promise(resolve => { releaseFirst = resolve })
const started = new Promise(resolve => { signalStarted = resolve })
const calls = []
mock.module('workflow/api', { namedExports: { start: async (_workflow, args) => {
  calls.push(args)
  if (calls.length === 1) { signalStarted(); await held }
} } })
Object.assign(process.env, {
  SLACK_BOT_TOKEN: 'test-only-bot-token', SLACK_SIGNING_SECRET: 'test-only-signing-secret',
  SLACK_APP_ID: 'A123', SLACK_TEAM_ID: 'T123', SLACK_BOT_USER_ID: 'U123',
  SLACK_USER_BINDINGS: '{"U456":"owner-a"}',
})
const { getSlackBot } = await import('../lib/slack/bot.ts')

test('overlapping mentions each start one workflow, and retries start no duplicates', async () => {
  const bot = getSlackBot()
  const adapter = bot.getAdapter('slack')
  // Keep real SDK concurrency/deduplication and the registered handler; skip Slack I/O.
  bot.dispatchToHandlers = async (_adapter, threadId, message) => bot.mentionHandlers[0]({ id: threadId }, message)
  const threadId = 'slack:C123:1'
  const message = id => ({ id, threadId, text: `mention ${id}`, raw: { team_id: 'T123' }, author: { userId: 'U456', isMe: false, isBot: false } })
  const first = bot.handleIncomingMessage(adapter, threadId, message('1'))
  await started
  try {
    await Promise.all(['2', '3'].map(id => bot.handleIncomingMessage(adapter, threadId, message(id))))
  } finally { releaseFirst() }
  await first
  for (const id of ['1', '2', '3']) await bot.handleIncomingMessage(adapter, threadId, message(id))
  assert.deepEqual(calls, ['1', '2', '3'].map(id => ['owner-a', threadId, `mention ${id}`]))
})
