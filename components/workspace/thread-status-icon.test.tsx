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

// Alex, 2026-11-02: a hollow circle read too close to 进行中's spinner and 空闲's slashed circle.
test('等待你 raises a hand, in rows and chips and in a header', () => {
  for (const small of [true, false]) {
    const html = renderToStaticMarkup(<ThreadStatusIcon group="waiting" small={small} />)
    assert.match(html, /lucide-hand\b/)
    assert.doesNotMatch(html, /lucide-circle\b/)
  }
  assert.match(renderToStaticMarkup(<ThreadStatusIcon status="stopped" waiting />), /lucide-hand\b/)
  assert.doesNotMatch(renderToStaticMarkup(<ThreadStatusIcon group="running" />), /lucide-hand\b/)
})

// Decision (coordinator, 2026-11-02, option A): the badge says its group, as the list does, never the run's raw status.
test('a thread\'s badge shows its group\'s icon and word: an unjudged finished run is 等待你, never 已完成', () => {
  const badge = (props: Parameters<typeof ThreadStatus>[0]) => renderToStaticMarkup(<ThreadStatus {...props} />)
  const table: [Parameters<typeof ThreadStatus>[0], string, RegExp][] = [
    [{ status: 'running' }, 'running', /lucide-loader-circle/],
    [{ status: 'waiting_input' }, 'waiting', /lucide-hand/],
    [{ status: 'succeeded' }, 'waiting', /lucide-hand/],
    [{ status: 'stopped' }, 'waiting', /lucide-hand/],
    [{ status: 'succeeded', outcome: 'done' }, 'resolved', /lucide-circle-check/],
    [{ status: 'failed' }, 'blocked', /lucide-circle-alert/],
    [{ status: 'succeeded', outcome: 'blocked' }, 'blocked', /lucide-circle-alert/],
    [{ status: 'stopped', outcome: 'idle' }, 'idle', /lucide-circle-slash/],
  ]
  for (const [props, group, icon] of table) {
    const html = badge(props)
    assert.match(html, new RegExp(`Shell\\.threads\\.state\\.${group}<`), JSON.stringify(props))
    assert.match(html, icon, JSON.stringify(props))
  }
  assert.doesNotMatch(badge({ status: 'running', icon: false }), /<svg/)
  assert.match(badge({ status: 'running', stopping: true }), /IssueThreads\.stopping/)
})
