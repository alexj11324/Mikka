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

test('a narrow column wraps the mode control onto its own row', () => {
  const html = renderToStaticMarkup(<Header {...base} wraps mode={<span data-test-mode="">Ask</span>} />)
  // The query is the column's own inline size: the header is a child of the
  // container, because a container query cannot size its own container.
  assert.match(html, /data-slot="thread-header-container"/)
  assert.match(html, /@container\/thread-header/)
  assert.match(html, /@max-\[22rem\]\/thread-header:flex-wrap/)
  assert.match(html, /@max-\[22rem\]\/thread-header:h-auto/)
  assert.match(html, /@max-\[22rem\]\/thread-header:order-last/)
  assert.match(html, /@max-\[22rem\]\/thread-header:w-full/)
  // A viewport unit here is the bug this guards: 320–360 px columns open in a
  // 1440 px window, where a `max-sm:` header never wrapped. The measured
  // 320/360 assertion is the browser spec, not this one.
  assert.doesNotMatch(html, /max-sm:/)
  // Without wraps the header stays one row; the mode control keeps its width.
  const oneRow = renderToStaticMarkup(<Header {...base} mode={<span data-test-mode="">Ask</span>} />)
  assert.doesNotMatch(oneRow, /@max-\[22rem\]\/thread-header:/)
  assert.match(oneRow, /class="flex min-w-0 items-center shrink-0"/)
})
