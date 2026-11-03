import assert from 'node:assert/strict'
import test from 'node:test'
import { chatPollInterval } from './chat-poll-interval'

test('the chat polls slowly when quiet, quickly while a turn starts, and leans on the stream while it streams', () => {
  assert.equal(chatPollInterval(undefined), 30_000)
  assert.equal(chatPollInterval({ working: false }), 30_000)
  assert.equal(chatPollInterval({ working: true }), 3_000)
  assert.equal(chatPollInterval({ working: true, streamRunId: 'wrun_1' }), 15_000)
})

test('the bot, task, thread and board lists poll once a minute while visible', async () => {
  const { readFileSync } = await import('node:fs')
  assert.match(readFileSync('components/swr-defaults.tsx', 'utf8'), /export const LIST_POLL_MS = 60_000/)
  for (const [file, uses] of [['components/nav/bot-list.tsx', 2], ['components/workspace/issue-workspace.tsx', 2], ['components/workspace/board-page.tsx', 1]] as const) {
    const source = readFileSync(file, 'utf8')
    assert.equal(source.match(/refreshInterval:[^,}]*LIST_POLL_MS/g)?.length, uses, file)
    assert.doesNotMatch(source, /refreshInterval: 15000/, file)
  }
})
