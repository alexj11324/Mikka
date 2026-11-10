import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('next-intl', { namedExports: {
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: () => 'time' }),
} })

let Header: typeof import('./thread-header')['ThreadHeader']
before(async () => { ({ ThreadHeader: Header } = await import('./thread-header')) })

const base = {
  issueId: 'issue', runId: 'run', title: 'A very long thread title that has to stay on one line', headingRef: createRef<HTMLHeadingElement>(),
  onStop: null, place: null, acceptanceBadge: null, identity: null, artifact: null, tabs: null, wraps: false,
} as const

test('the mode control has its own slot and a long title still truncates', () => {
  const html = renderToStaticMarkup(<Header {...base} mode={<span data-test-mode="">Ask</span>} />)
  assert.match(html, /data-slot="thread-mode-slot"/)
  assert.match(html, /data-test-mode/)
  assert.match(html, /min-w-0 truncate/)
  // Without a mode the slot is absent, not an empty box.
  const plain = renderToStaticMarkup(<Header {...base} />)
  assert.doesNotMatch(plain, /data-slot="thread-mode-slot"/)
})

test('a narrow header may wrap the mode control onto its own row', () => {
  const html = renderToStaticMarkup(<Header {...base} wraps mode={<span data-test-mode="">Ask</span>} />)
  assert.match(html, /max-sm:h-auto max-sm:flex-wrap/)
  assert.match(html, /max-sm:order-last max-sm:w-full/)
})
