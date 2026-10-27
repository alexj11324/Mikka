import { test } from 'node:test'
import assert from 'node:assert/strict'
import { citedIds, remarkCitations, safeSourceUrl, splitCitations, suggestionCitations, suggestionLabel } from './citations'

const ISSUE = '3f6c1a52-8d0e-4b7a-9c3e-1f2a3b4c5d6e'
const RUN = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SUGGESTION = '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'

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
  assert.deepEqual(citedIds([`[[issue:${ISSUE}]] and ${RUN}`, `[[run:${RUN}]]`]), { issueIds: [ISSUE, RUN], runIds: [RUN], suggestionIds: [] })
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
  assert.deepEqual(citedIds([`https://example.com/runs/${RUN}`]), { issueIds: [], runIds: [], suggestionIds: [] })
})

type Node = { type: string; value?: string; url?: string; children?: Node[] }
const text = (value: string): Node => ({ type: 'text', value })
const link = (url: string, value: string): Node => ({ type: 'link', url, children: [text(value)] })
/** Runs the plugin on a paragraph, as remark-parse and remark-gfm would hand it over. */
const transform = (...children: Node[]) => {
  const tree: Node = { type: 'root', children: [{ type: 'paragraph', children }] }
  remarkCitations()(tree)
  return tree.children?.[0].children
}

test('remarkCitations links citations for the chip renderer and keeps line breaks', () => {
  assert.deepEqual(transform(text(`已派给 [[run:${RUN}]]\n处理 ${ISSUE}`)), [
    text('已派给 '), link(`#cite/run/${RUN}`, `[[run:${RUN}]]`), { type: 'break' }, text('处理 '), link(`#cite/any/${ISSUE}`, ISSUE),
  ])
})

test('remarkCitations leaves code and Markdown links alone', () => {
  const children = [{ type: 'inlineCode', value: ISSUE }, text(' '), link('https://github.com/a/b/pull/1', 'PR')]
  assert.deepEqual(transform(...structuredClone(children)), children)
})

test('remarkCitations cuts a GFM autolink glued to Chinese text', () => {
  assert.deepEqual(transform(text('看'), link('https://example.com/a。后面', 'https://example.com/a。后面')), [
    text('看'), link('https://example.com/a', 'https://example.com/a'), text('。后面'),
  ])
})

test('splitCitations reads a suggestion token, and citedIds looks it up only as a suggestion', () => {
  assert.deepEqual(splitCitations(`先回 [[suggestion:${SUGGESTION.toUpperCase()}]]，再看 [[Suggestion:${SUGGESTION}]]。`), [
    { type: 'text', text: '先回 ' },
    { type: 'citation', kind: 'suggestion', id: SUGGESTION, raw: `[[suggestion:${SUGGESTION.toUpperCase()}]]` },
    { type: 'text', text: '，再看 ' },
    { type: 'citation', kind: 'suggestion', id: SUGGESTION, raw: `[[Suggestion:${SUGGESTION}]]` },
    { type: 'text', text: '。' },
  ])
  assert.deepEqual(citedIds([`[[suggestion:${SUGGESTION}]] for [[issue:${ISSUE}]]`]), { issueIds: [ISSUE], runIds: [], suggestionIds: [SUGGESTION] })
  // Malformed tokens stay text; their id is read as a bare issue or run id, never a suggestion.
  assert.deepEqual(citedIds([`[[suggestion: ${SUGGESTION}]] [[email:${SUGGESTION}]]`]).suggestionIds, [])
})

test('remarkCitations links a suggestion token for the chip renderer', () => {
  assert.deepEqual(transform(text(`看 [[suggestion:${SUGGESTION}]] 吧`)), [text('看 '), link(`#cite/suggestion/${SUGGESTION}`, `[[suggestion:${SUGGESTION}]]`), text(' 吧')])
})

test('suggestionLabel prefers the action title, then a GitHub number, then a cut title', () => {
  assert.equal(suggestionLabel({ app: 'gmail', title: 'Re: 周四的会议能否改到下周一下午三点？', actionTitle: ' 会议改期 ', url: null }), '会议改期')
  assert.equal(suggestionLabel({ app: 'github', title: 'feat: suggestion citations', url: 'https://github.com/alexj11324/Mikka/pull/212' }), 'PR #212')
  assert.equal(suggestionLabel({ app: 'github', title: 'Crash on load', url: 'https://github.com/alexj11324/Mikka/issues/9#issuecomment-1' }), 'Issue #9')
  assert.equal(suggestionLabel({ app: 'notion', title: '发布清单', url: 'https://www.notion.so/x' }), '发布清单')
  assert.equal(suggestionLabel({ app: 'slack', title: 'can someone   look at\nthe deploy?', url: null }), 'can someone loo…')
  assert.equal(suggestionLabel({ app: 'gmail', title: '周四的会议能否改到下周一下午三点再讨论', url: null }), '周四的会议能否改到下周一下午三…')
})

test('suggestionCitations keeps only the person\'s own rows and only http(s) links', () => {
  const rows = [
    { id: SUGGESTION, userId: 'alex', source: 'github' as const, title: 'feat: chips', url: 'https://github.com/alexj11324/Mikka/pull/212' },
    { id: ISSUE, userId: 'someone-else', source: 'gmail' as const, title: 'secret subject', url: 'https://mail.google.com/x' },
    { id: RUN, userId: 'alex', source: 'slack' as const, title: 'deploy?', url: 'javascript:alert(1)' },
  ]
  const sources = suggestionCitations('alex', rows)
  assert.deepEqual(sources[SUGGESTION], { kind: 'suggestion', id: SUGGESTION, app: 'github', label: 'PR #212', title: 'feat: chips', url: 'https://github.com/alexj11324/Mikka/pull/212' })
  assert.equal(sources[ISSUE], undefined)
  assert.equal(JSON.stringify(sources).includes('secret'), false)
  assert.equal(sources[RUN]?.url, null)
  assert.deepEqual(suggestionCitations('nobody', rows), {})
  assert.equal(safeSourceUrl('data:text/html,hi'), null)
  assert.equal(safeSourceUrl('not a url'), null)
})
