import assert from 'node:assert/strict'
import test from 'node:test'

test('the chat reads on its live key, never on a timer', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync('components/coordinator/coordinator-chat.tsx', 'utf8')
  assert.match(source, /useLiveKey\('bot_chat',/)
  assert.doesNotMatch(source, /refreshInterval/)
})

test('migrated lists use shared invalidation while the fallback interval remains one minute', async () => {
  const { readFileSync } = await import('node:fs')
  // Lists read on push only; the one-minute read is the live layer's fallback while its socket is down.
  assert.match(readFileSync('lib/live/channel.ts', 'utf8'), /export const LIVE_FALLBACK_MS = 60_000/)
  assert.doesNotMatch(readFileSync('components/swr-defaults.tsx', 'utf8'), /POLL_MS|refreshInterval/)
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
