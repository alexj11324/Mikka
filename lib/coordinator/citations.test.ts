import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { citedIds, remarkCitations, splitCitations } from './citations'

const ISSUE = '3f6c1a52-8d0e-4b7a-9c3e-1f2a3b4c5d6e'
const RUN = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

test('splitCitations keeps text and citations in order', () => {
  assert.deepEqual(splitCitations(`Dispatched [[run:${RUN}]] for [[issue:${ISSUE}]].`), [
    { type: 'text', text: 'Dispatched ' },
    { type: 'citation', kind: 'run', id: RUN, raw: `[[run:${RUN}]]` },
    { type: 'text', text: ' for ' },
    { type: 'citation', kind: 'issue', id: ISSUE, raw: `[[issue:${ISSUE}]]` },
    { type: 'text', text: '.' },
  ])
})

test('splitCitations reads a bare id as a citation of either kind', () => {
  assert.deepEqual(splitCitations(`Run ${RUN.toUpperCase()} is queued`), [
    { type: 'text', text: 'Run ' },
    { type: 'citation', kind: null, id: RUN, raw: RUN.toUpperCase() },
    { type: 'text', text: ' is queued' },
  ])
  assert.deepEqual(splitCitations('nothing cited'), [{ type: 'text', text: 'nothing cited' }])
})

test('citedIds looks bare ids up as both issues and runs', () => {
  assert.deepEqual(citedIds([`[[issue:${ISSUE}]] and ${RUN}`, `[[run:${RUN}]]`]), { issueIds: [ISSUE, RUN], runIds: [RUN] })
})

test('splitCitations reads Markdown links and bare URLs as web sources', () => {
  assert.deepEqual(splitCitations('PR 在 [Mikka#28](https://github.com/alexj11324/Mikka/pull/28)，文档见 https://stencil.so/tern。'), [
    { type: 'text', text: 'PR 在 ' },
    { type: 'link', url: 'https://github.com/alexj11324/Mikka/pull/28', label: 'Mikka#28', raw: '[Mikka#28](https://github.com/alexj11324/Mikka/pull/28)' },
    { type: 'text', text: '，文档见 ' },
    { type: 'link', url: 'https://stencil.so/tern', label: null, raw: 'https://stencil.so/tern' },
    { type: 'text', text: '。' },
  ])
  assert.deepEqual(splitCitations(`see https://example.com/runs/${RUN}.`), [
    { type: 'text', text: 'see ' },
    { type: 'link', url: `https://example.com/runs/${RUN}`, label: null, raw: `https://example.com/runs/${RUN}` },
    { type: 'text', text: '.' },
  ])
  assert.deepEqual(citedIds([`https://example.com/runs/${RUN}`]), { issueIds: [], runIds: [] })
})

const markdown = (text: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm, remarkCitations] }, text))

test('remarkCitations links citations for the chip renderer and keeps line breaks', () => {
  assert.equal(markdown(`已派给 [[run:${RUN}]]\n处理 ${ISSUE}`),
    `<p>已派给 <a href="#cite/run/${RUN}">[[run:${RUN}]]</a><br/>\n处理 <a href="#cite/any/${ISSUE}">${ISSUE}</a></p>`)
})

test('remarkCitations leaves code and Markdown links alone', () => {
  assert.equal(markdown(`\`${ISSUE}\` [PR](https://github.com/a/b/pull/1)`),
    `<p><code>${ISSUE}</code> <a href="https://github.com/a/b/pull/1">PR</a></p>`)
})

test('remarkCitations links a URL glued to Chinese text', () => {
  assert.equal(markdown('看https://example.com/a。'), '<p>看<a href="https://example.com/a">https://example.com/a</a>。</p>')
})
