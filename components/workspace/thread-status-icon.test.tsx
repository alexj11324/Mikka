import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

// The icon's label reads as its key.
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` } })
let threadGroupOfRun: typeof import('./thread-status-icon')['threadGroupOfRun']
let ThreadStatusIcon: typeof import('./thread-status-icon')['ThreadStatusIcon']
let ThreadStatus: typeof import('./thread-status-icon')['ThreadStatus']
before(async () => { ({ threadGroupOfRun, ThreadStatusIcon, ThreadStatus } = await import('./thread-status-icon')) })

test('a card or chip shows the run\'s group: done is 已解决, blocked and failed 受阻', () => {
  assert.equal(threadGroupOfRun('running'), 'running')
  assert.equal(threadGroupOfRun('succeeded', 'done'), 'resolved')
  assert.equal(threadGroupOfRun('succeeded', 'blocked'), 'blocked')
  assert.equal(threadGroupOfRun('failed', 'failed'), 'blocked')
  assert.equal(threadGroupOfRun('stopped', 'idle'), 'idle')
  assert.equal(threadGroupOfRun('succeeded', 'needs_input'), 'waiting')
})

test('not judged yet: failed is 受阻, any other ended run 等待你, never 已解决; a question waits', () => {
  assert.equal(threadGroupOfRun('failed'), 'blocked')
  assert.equal(threadGroupOfRun('succeeded'), 'waiting')
  assert.equal(threadGroupOfRun('succeeded', null), 'waiting')
  assert.equal(threadGroupOfRun('stopped', null, true), 'waiting')
  assert.equal(threadGroupOfRun('waiting_input'), 'waiting')
})

// Alex, 2026-11-04: a task and a thread must never look alike. A task is a circle; a thread is a bubble with a dot.
test('a thread is a speech bubble with its group as a dot, never a circle like a task\'s status', () => {
  for (const group of ['running', 'waiting', 'blocked', 'idle', 'resolved'] as const) {
    for (const small of [true, false]) {
      const html = renderToStaticMarkup(<ThreadStatusIcon group={group} small={small} />)
      assert.match(html, /lucide-message-circle\b/)
      assert.doesNotMatch(html, /lucide-circle|lucide-hand|lucide-loader/)
      assert.match(html, new RegExp(`data-thread-dot="${group}"`))
      assert.match(html, new RegExp(`aria-label="Shell\\.threads\\.state\\.${group}"`), 'the dot is never the only sign')
    }
  }
  assert.match(renderToStaticMarkup(<ThreadStatusIcon status="stopped" waiting />), /data-thread-dot="waiting"/)
})

// Decision (coordinator, 2026-11-02, option A): the badge says its group, as the list does, never the run's raw status.
test('a thread\'s badge shows its group\'s icon and word: an unjudged finished run is 等待你, never 已完成', () => {
  const badge = (props: Parameters<typeof ThreadStatus>[0]) => renderToStaticMarkup(<ThreadStatus {...props} />)
  const table: [Parameters<typeof ThreadStatus>[0], string, RegExp][] = [
    [{ status: 'running' }, 'running', /data-thread-dot="running"/],
    [{ status: 'waiting_input' }, 'waiting', /data-thread-dot="waiting"/],
    [{ status: 'succeeded' }, 'waiting', /data-thread-dot="waiting"/],
    [{ status: 'stopped' }, 'waiting', /data-thread-dot="waiting"/],
    [{ status: 'succeeded', outcome: 'done' }, 'resolved', /data-thread-dot="resolved"/],
    [{ status: 'failed' }, 'blocked', /data-thread-dot="blocked"/],
    [{ status: 'succeeded', outcome: 'blocked' }, 'blocked', /data-thread-dot="blocked"/],
    [{ status: 'stopped', outcome: 'idle' }, 'idle', /data-thread-dot="idle"/],
  ]
  for (const [props, group, icon] of table) {
    const html = badge(props)
    assert.match(html, new RegExp(`Shell\\.threads\\.state\\.${group}<`), JSON.stringify(props))
    assert.match(html, icon, JSON.stringify(props))
  }
  assert.doesNotMatch(badge({ status: 'running', icon: false }), /<svg/)
  assert.match(badge({ status: 'running', stopping: true }), /IssueThreads\.stopping/)
})
