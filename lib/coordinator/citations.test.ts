import { test } from 'node:test'
import assert from 'node:assert/strict'
import { citedIds, namedCitations, pairCitations, remarkCitations, runThreadName, runTitle, splitCitations, type CitationSource } from './citations'

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

test('namedCitations writes cited threads and tasks as their names for a preview', () => {
  const sources: Record<string, CitationSource> = {
    [RUN]: { kind: 'run', id: RUN, agentName: 'Mikka Backend', harness: 'codex', status: 'running', issue: null, name: '修复 daemon 重连', summary: null, steps: 0, createdAt: '2026-11-01T00:00:00.000Z', finishedAt: null },
    [ISSUE]: { kind: 'issue', id: ISSUE, number: 12, identifier: 'MIK-12', title: '看板横向滚动', status: 'todo', priority: 'normal' },
  }
  assert.equal(namedCitations(`线程在这里：${RUN}`, sources), '线程在这里：修复 daemon 重连')
  assert.equal(namedCitations(`任务 [[issue:${ISSUE}]]，线程 [[run:${RUN}]]`, sources), '任务 看板横向滚动，线程 修复 daemon 重连')
  const hidden = '00000000-0000-4000-8000-000000000000'
  assert.equal(namedCitations(`看 [PR](https://github.com/a/b/pull/1)，${hidden} 不可见`, sources), '看 [PR](https://github.com/a/b/pull/1)， 不可见')
  assert.equal(namedCitations(`[[issue:${RUN}]]`, sources), '')
  assert.equal(namedCitations(`root = RunChip("${RUN}")`, sources), `root = RunChip("${RUN}")`)
})

test('remarkCitations cuts a GFM autolink glued to Chinese text', () => {
  assert.deepEqual(transform(text('看'), link('https://example.com/a。后面', 'https://example.com/a。后面')), [
    text('看'), link('https://example.com/a', 'https://example.com/a'), text('。后面'),
  ])
})

// A conversation is always named by its own bounded short title (decision 2026-11-13-1405); the task's title is the task's.
const LONG_CJK = '修复登录后的工作区前缀和查询参数丢失问题并补充回归测试覆盖所有入口'
const LONG_LATIN = 'Fix the workspace prefix and query parameters that are lost after sign in and add regression tests'

test('runTitle is the conversation\'s own bounded short title: stored title, else what it was asked, else its task\'s short title', () => {
  const task = { id: ISSUE, number: 12, identifier: 'MIK-12', title: LONG_CJK, shortTitle: '登录前缀修复' }
  assert.equal(runTitle({ title: '回调参数排查', name: 'Speed up the home page', issue: task }), '回调参数排查', 'its stored title wins')
  assert.equal(runTitle({ name: 'Speed up the home page', issue: task }), 'Speed up the home page', 'then what it was asked, never the task\'s title')
  assert.equal(runTitle({ name: '', issue: task }), '登录前缀修复', 'an empty prompt falls back to the task\'s short title')
  assert.equal(runTitle({ name: '', issue: { ...task, shortTitle: null } }), '修复登录后的工作区前缀和', 'a task without one is bounded the same way')
  assert.equal(runTitle({ name: 'Check the logs', issue: null }), 'Check the logs', 'a standalone run')
  assert.equal(runTitle({ name: LONG_CJK, issue: null }), '修复登录后的工作区前缀和', 'long CJK: 12 characters')
  assert.equal([...runTitle({ name: LONG_CJK, issue: null })].length, 12)
  assert.equal(runTitle({ name: LONG_LATIN, issue: null }), 'Fix the workspace prefix and query', 'long Latin: 6 words')
  assert.ok(runTitle({ name: 'x'.repeat(200), issue: null }).length <= 60, '60 characters at most')
  assert.equal(runTitle({ name: `${'修'.repeat(59)}…`, issue: null }), '修'.repeat(12), 'an already cut name is bounded again, without its ellipsis')
})

test('runThreadName puts the task\'s code before the same conversation title', () => {
  assert.equal(runThreadName({ name: 'Speed up the home page', issue: { id: ISSUE, number: 12, identifier: 'MIK-12', title: LONG_CJK } }), 'MIK-12 Speed up the home page')
  assert.equal(runThreadName({ name: '', issue: { id: ISSUE, number: null, identifier: null, title: '首页提速' } }), '首页提速')
  assert.equal(runThreadName({ name: LONG_LATIN, issue: null }), 'Fix the workspace prefix and query')
})

test('a thread cited straight after its task is marked as that task\'s pair; anything between them keeps them apart', () => {
  const after = (text: string) => pairCitations(splitCitations(text)).flatMap(part => part.type === 'citation' ? [[part.kind, part.after ?? null]] : [])
  assert.deepEqual(after(`[[issue:${ISSUE}]] [[run:${RUN}]]`), [['issue', null], ['run', ISSUE]])
  assert.deepEqual(after(`[[issue:${ISSUE}]][[run:${RUN}]]`), [['issue', null], ['run', ISSUE]], 'no space at all')
  assert.deepEqual(after(`[[issue:${ISSUE}]] 的线程 [[run:${RUN}]]`), [['issue', null], ['run', null]], 'words between')
  assert.deepEqual(after(`[[issue:${ISSUE}]]\n[[run:${RUN}]]`), [['issue', null], ['run', null]], 'a line break between')
  assert.deepEqual(after(`[[run:${RUN}]] [[issue:${ISSUE}]]`), [['run', null], ['issue', null]], 'the other order')
  assert.deepEqual(pairCitations(splitCitations(`看 [[issue:${ISSUE}]]   [[run:${RUN}]]。`)).map(part => part.type === 'text' ? part.text : part.type), ['看 ', 'citation', 'citation', '。'], 'the gap is the thread\'s to draw: one word gap')
})
