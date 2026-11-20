import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

// The icon's label reads as its key.
mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en', useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` } })
let threadGroupOfRun: typeof import('./thread-status-icon')['threadGroupOfRun']
let GROUP_BADGES: typeof import('./thread-status-icon')['GROUP_BADGES']
let ThreadStatusIcon: typeof import('./thread-status-icon')['ThreadStatusIcon']
let ThreadStatus: typeof import('./thread-status-icon')['ThreadStatus']
let threadMarkOf: typeof import('@/lib/state-mark')['threadMarkOf']
let THREAD_GROUPS: typeof import('@/lib/thread-groups')['THREAD_GROUPS']
before(async () => {
  ;({ threadGroupOfRun, GROUP_BADGES, ThreadStatusIcon, ThreadStatus } = await import('./thread-status-icon'))
  ;({ threadMarkOf } = await import('@/lib/state-mark'))
  ;({ THREAD_GROUPS } = await import('@/lib/thread-groups'))
})

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

// Decision 2026-11-19-1630 replaces the thread's bubble and corner dot of 2026-11-04-2330: a thread is drawn with the
// same marks a task's status uses, so one vocabulary covers both.
test('a thread draws its group\'s mark from the shared registry, and its label names the group', () => {
  for (const group of THREAD_GROUPS) {
    const mark = threadMarkOf(group)
    for (const small of [true, false]) {
      const html = renderToStaticMarkup(<ThreadStatusIcon group={group} small={small} />)
      assert.match(html, new RegExp(`data-mark="${mark.shape}"`), `${group} draws its mark`)
      assert.match(html, new RegExp(`data-thread-mark="${group}"`))
      assert.match(html, new RegExp(`aria-label="Shell\\.threads\\.state\\.${group}"`), 'the colour is never the only sign')
    }
  }
  assert.match(renderToStaticMarkup(<ThreadStatusIcon status="stopped" waiting />), /data-thread-mark="waiting"/)
  // A surface that shows no state beside the mark draws the shape alone, in the colour of where it sits.
  assert.doesNotMatch(renderToStaticMarkup(<ThreadStatusIcon group="waiting" dot={false} />), /text-(?:muted|warning|success|info|label|destructive)/)
  assert.doesNotMatch(renderToStaticMarkup(<ThreadStatusIcon group="waiting" accent />), /text-label-blue/)
})

test('a thread\'s badge says its group, and takes its colour from the same mark', () => {
  const badge = (props: Parameters<typeof ThreadStatus>[0]) => renderToStaticMarkup(<ThreadStatus {...props} />)
  const table: [Parameters<typeof ThreadStatus>[0], string, string][] = [
    [{ status: 'running' }, 'running', 'half'],
    [{ status: 'waiting_input' }, 'waiting', 'hand'],
    [{ status: 'succeeded' }, 'waiting', 'hand'],
    [{ status: 'stopped' }, 'waiting', 'hand'],
    [{ status: 'succeeded', outcome: 'done' }, 'resolved', 'check'],
    [{ status: 'failed' }, 'blocked', 'x'],
    [{ status: 'succeeded', outcome: 'blocked' }, 'blocked', 'x'],
    [{ status: 'stopped', outcome: 'idle' }, 'idle', 'empty'],
  ]
  for (const [props, group, shape] of table) {
    const html = badge(props)
    assert.match(html, new RegExp(`Shell\\.threads\\.state\\.${group}<`), JSON.stringify(props))
    assert.match(html, new RegExp(`data-thread-mark="${group}"`), JSON.stringify(props))
    assert.match(html, new RegExp(`data-mark="${shape}"`), JSON.stringify(props))
  }
  assert.doesNotMatch(badge({ status: 'running', icon: false }), /<svg/)
  assert.match(badge({ status: 'running', stopping: true }), /IssueThreads\.stopping/)
  // 等待你 is the hand's info tint, so its badge is the info one, not a colour of its own.
  assert.equal(GROUP_BADGES.waiting, 'info-light')
  assert.equal(GROUP_BADGES.resolved, 'success-light')
  assert.equal(GROUP_BADGES.blocked, 'destructive-light')
})
