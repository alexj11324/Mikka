import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as Y from 'yjs'
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import { WARNED_ISSUE_LIMIT, warnedIssueCount } from './issue-document-seed'
import { createDocumentSeed, issueEditorSchema, readableIssueContent } from '../components/workspace/issue-editor-schema'

const seeded = (update: Uint8Array) => { const doc = new Y.Doc(); Y.applyUpdate(doc, update); try { return yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')) } finally { doc.destroy() } }
const nested = (depth: number) => { let node: Record<string, unknown> = { type: 'paragraph', content: [{ type: 'text', text: 'deep' }] }; for (let i = 0; i < depth; i++) node = { type: 'blockquote', content: [node] }; return { type: 'doc', content: [node] } }

test('invalid content yields no seed (read-only), warning once per issue without leaking content', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  for (const content of [null, undefined, 'text', 42, [], {}, { type: 'paragraph' }, { type: 'doc', content: [{ type: 'mystery' }] }, { type: 'doc', content: [{ type: 'text', text: 'loose' }] }])
    assert.equal(createDocumentSeed(content, 'issue-a'), null)
  assert.equal(warn.mock.callCount(), 1)
  assert.match(String(warn.mock.calls[0].arguments[0]), /issue-a/)
  assert.doesNotMatch(String(warn.mock.calls[0].arguments[0]), /loose|mystery/)
  createDocumentSeed(null, 'issue-b')
  assert.equal(warn.mock.callCount(), 2)
})

test('a valid document in the real editor schema seeds unchanged', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done', marks: [{ type: 'bold' }] }] }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Keep' }] },
  ] }
  const update = createDocumentSeed(doc, 'issue-c')
  assert.ok(update)
  const back = seeded(update) as { content: Array<{ type: string; content?: unknown[] }> }
  assert.deepEqual(back.content.map(node => node.type), ['heading', 'taskList', 'paragraph'])
  assert.match(JSON.stringify(back), /"Keep"/)
  assert.match(JSON.stringify(back), /"Done"/)
  assert.equal(warn.mock.callCount(), 0)
})

test('an empty text node is dropped and the rest of the document is kept', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }, { type: 'text', text: 'kept' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] }
  assert.deepEqual(readableIssueContent(doc), { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kept' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'second' }] }] })
  const update = createDocumentSeed(doc, 'issue-d')
  assert.ok(update)
  assert.match(JSON.stringify(seeded(update)), /"kept".*"second"/)
  assert.equal(warn.mock.callCount(), 0)
})

test('an empty doc stays editable rather than read-only', () => {
  assert.ok(createDocumentSeed({ type: 'doc', content: [] }, 'issue-empty'))
  assert.ok(createDocumentSeed({ type: 'doc' }, 'issue-empty'))
})

test('a 3000-deep blockquote nest returns no seed instead of throwing', (t) => {
  t.mock.method(console, 'warn', () => {})
  assert.doesNotThrow(() => createDocumentSeed(nested(3000), 'issue-deep'))
  assert.equal(createDocumentSeed(nested(3000), 'issue-deep'), null)
})

test('the warn-dedupe set is bounded', (t) => {
  t.mock.method(console, 'warn', () => {})
  for (let i = 0; i < WARNED_ISSUE_LIMIT * 3; i++) createDocumentSeed(null, `bulk-${i}`)
  assert.equal(warnedIssueCount(), WARNED_ISSUE_LIMIT)
})

test('the real editor schema is the one wired into the editor, the detail page and the server', () => {
  assert.ok(issueEditorSchema().nodes.taskItem && issueEditorSchema().nodes.richTextOutline && issueEditorSchema().marks.comment)
  const editor = readFileSync(new URL('../components/workspace/issue-editor.tsx', import.meta.url), 'utf8')
  assert.match(editor, /export \{ createEditorExtensions, createDocumentSeed \} from '\.\/issue-editor-schema'/)
  assert.match(editor, /readableIssueContent\(content\)/)
  assert.match(editor, /const editable = !disabled && !unreadable/)
  const detail = readFileSync(new URL('../components/workspace/task-detail.tsx', import.meta.url), 'utf8')
  assert.match(detail, /const readOnly = seed === null/)
  assert.match(detail, /useSWR\(readOnly \? null :/)
  assert.match(detail, /sharedDoc=\{readOnly \? undefined : sync\.doc\}/)
  for (const file of ['../app/actions/collaboration.ts', './issue-create.ts'])
    assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /readableIssueContent/)
})
