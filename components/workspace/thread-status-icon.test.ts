import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The icon's label reads as its key.
mock.module('next-intl', { namedExports: { useTranslations: () => (key: string) => key } })
let threadGroupOfRun: typeof import('./thread-status-icon')['threadGroupOfRun']
let ThreadStatusIcon: typeof import('./thread-status-icon')['ThreadStatusIcon']
before(async () => { ({ threadGroupOfRun, ThreadStatusIcon } = await import('./thread-status-icon')) })

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
    const html = renderToStaticMarkup(createElement(ThreadStatusIcon, { group: 'waiting', small }))
    assert.match(html, /lucide-hand\b/)
    assert.doesNotMatch(html, /lucide-circle\b/)
  }
  assert.match(renderToStaticMarkup(createElement(ThreadStatusIcon, { status: 'stopped', waiting: true })), /lucide-hand\b/)
  assert.doesNotMatch(renderToStaticMarkup(createElement(ThreadStatusIcon, { group: 'running' })), /lucide-hand\b/)
})
