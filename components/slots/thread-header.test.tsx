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

test('a long title still truncates and the header keeps its slots', () => {
  const html = renderToStaticMarkup(<Header {...base} />)
  assert.match(html, /min-w-0 truncate/)
  assert.match(html, /A very long thread title that has to stay on one line/)
})

test('a narrow header may wrap onto its own row', () => {
  const html = renderToStaticMarkup(<Header {...base} wraps />)
  assert.match(html, /max-sm:h-auto max-sm:flex-wrap/)
})

