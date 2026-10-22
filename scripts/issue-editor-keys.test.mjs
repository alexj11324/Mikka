import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Window } from 'happy-dom'

const window = new Window({ url: 'http://localhost/mikka/en' })
function expose(key, value) {
  try { globalThis[key] = value } catch { Object.defineProperty(globalThis, key, { value, configurable: true }) }
}
expose('window', window)
expose('document', window.document)
expose('navigator', window.navigator)
expose('HTMLElement', window.HTMLElement)
expose('Element', window.Element)
expose('Node', window.Node)
expose('DocumentFragment', window.DocumentFragment)
expose('DOMParser', window.DOMParser)
expose('MutationObserver', window.MutationObserver)
expose('getComputedStyle', window.getComputedStyle.bind(window))
expose('requestAnimationFrame', window.requestAnimationFrame.bind(window))
expose('cancelAnimationFrame', window.cancelAnimationFrame.bind(window))
expose('Range', window.Range)
expose('Document', window.Document)
expose('NodeFilter', window.NodeFilter)
expose('KeyboardEvent', window.KeyboardEvent)

const { Editor } = await import('@tiptap/core')
const Y = await import('yjs')
const { Collaboration } = await import('@tiptap/extension-collaboration')
const { createEditorExtensions, createDocumentSeed } = await import('../components/workspace/issue-editor.tsx')
const { bindThreadRepaint, createThreadStore } = await import('../components/blocks/rich-text-editor-4/components/rich-text-comments.ts')

function settle() {
  return new Promise(resolve => setTimeout(resolve, 20))
}

function mount(content) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, createDocumentSeed(content))
  const host = document.createElement('div')
  document.body.append(host)
  const editor = new Editor({
    element: host,
    extensions: [
      ...createEditorExtensions(() => false, 'QA', true, false, ''),
      Collaboration.configure({ document: doc, field: 'default' }),
    ],
  })
  const stop = bindThreadRepaint(editor, createThreadStore(doc).subscribe)
  return {
    editor,
    destroy() { stop(); editor.destroy(); doc.destroy(); host.remove() },
  }
}

test('description edits do not repaint from every Yjs update', () => {
  const source = readFileSync(new URL('../components/workspace/issue-editor.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /threadDoc\.on\(\s*['"]update['"]/)
})

test('Enter, Backspace, Delete and select-all delete keep the description', async () => {
  const seeded = mount({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello QA' }] }] })
  try {
    seeded.editor.commands.command(({ tr }) => {
      tr.insertText('!', tr.doc.content.size - 1)
      return true
    })
    assert.equal(seeded.editor.getText(), 'Hello QA!')
    seeded.editor.chain().focus('end').run()
    assert.doesNotThrow(() => seeded.editor.commands.keyboardShortcut('Enter'))
    await settle()
    const afterEnter = seeded.editor.getJSON().content
    assert.equal(afterEnter.length, 2)
    assert.equal(afterEnter[0].content?.[0]?.text, 'Hello QA!')
    assert.equal(afterEnter[1].content, undefined)

    seeded.editor.commands.selectAll()
    assert.doesNotThrow(() => seeded.editor.commands.keyboardShortcut('Backspace'))
    await settle()
    assert.deepEqual(seeded.editor.getJSON().content.map(node => node.type), ['paragraph'])
    assert.equal(seeded.editor.getText(), '')

    assert.doesNotThrow(() => seeded.editor.commands.keyboardShortcut('Delete'))
    await settle()
    assert.equal(seeded.editor.getText(), '')
  } finally {
    seeded.destroy()
  }

  const split = mount({
    type: 'doc',
    content: [
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
    ],
  })
  try {
    split.editor.commands.focus('start')
    assert.doesNotThrow(() => split.editor.commands.keyboardShortcut('Delete'))
    await settle()
    assert.match(split.editor.getText(), /second/)
    assert.equal(split.editor.getJSON().content[0]?.content?.[0]?.text, 'second')
  } finally {
    split.destroy()
  }
})
