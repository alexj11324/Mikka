import assert from 'node:assert/strict'
import test from 'node:test'
import { chatPollInterval } from './chat-poll-interval'

test('the chat polls slowly when quiet, quickly while a turn starts, and leans on the stream while it streams', () => {
  assert.equal(chatPollInterval(undefined), 30_000)
  assert.equal(chatPollInterval({ working: false }), 30_000)
  assert.equal(chatPollInterval({ working: true }), 3_000)
  assert.equal(chatPollInterval({ working: true, streamRunId: 'wrun_1' }), 15_000)
})

test('migrated lists use shared invalidation while the fallback interval remains one minute', async () => {
  const { readFileSync } = await import('node:fs')
  assert.match(readFileSync('components/swr-defaults.tsx', 'utf8'), /export const LIST_POLL_MS = 60_000/)
  // Actual React + SWR tests in scripts/use-live-lists.live.test.tsx cover
  // healthy silence beyond 60 s, push, foreground catch-up and owner changes.
  for (const [file, hooks] of [
    ['components/nav/bot-list.tsx', ['useLiveBotChatList', 'useLiveGroupList']],
    ['components/workspace/issue-workspace.tsx', ['useLiveIssueList', 'useLiveThreadList', 'useLiveBotRoster', 'useLiveGroupList']],
    ['components/workspace/board-page.tsx', ['useLiveTaskRunList']],
  ] as const) {
    const source = readFileSync(file, 'utf8')
    for (const hook of hooks) assert.ok(source.includes(hook + '('), file + ': ' + hook)
    assert.doesNotMatch(source, /refreshInterval\s*:/, file)
  }
})
