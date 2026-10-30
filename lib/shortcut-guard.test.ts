import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { bufferTypeAhead, typingOrDialog } from './shortcut-guard'

test('keys typed before the new-task dialog mounts are kept', () => {
  assert.equal(bufferTypeAhead('', 'd', false), 'd')
  assert.equal(bufferTypeAhead('dcdc', ' ', false), 'dcdc ')
  assert.equal(bufferTypeAhead('dcdc ', 't', false), 'dcdc t')
  assert.equal(bufferTypeAhead('dcdc test', 'x', true), null)
  assert.equal(bufferTypeAhead('title', 'Enter', false), null)
  assert.equal(bufferTypeAhead('x'.repeat(200), 'y', false), 'x'.repeat(200))
})

test('single-key shortcuts stay quiet while a dialog or field is focused', () => {
  const window = new Window()
  const previous = globalThis.document
  Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true })
  try {
    const input = window.document.createElement('input')
    window.document.body.append(input)
    assert.equal(typingOrDialog(input), true)
    const dialog = window.document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-open', '')
    const body = window.document.createElement('div')
    dialog.append(body)
    window.document.body.append(dialog)
    assert.equal(typingOrDialog(body), true)
    assert.equal(typingOrDialog(window.document.body), true)
    dialog.removeAttribute('data-open')
    const plain = window.document.createElement('div')
    window.document.body.append(plain)
    assert.equal(typingOrDialog(plain), false)
  } finally {
    Object.defineProperty(globalThis, 'document', { value: previous, configurable: true })
    window.close()
  }
})

test('a key on <body> is still guarded while a field keeps focus', () => {
  const window = new Window()
  const previous = globalThis.document
  Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true })
  try {
    const textarea = window.document.createElement('textarea')
    textarea.readOnly = true
    window.document.body.append(textarea)
    textarea.focus()
    assert.equal(typingOrDialog(window.document.body), true)
    textarea.blur()
    assert.equal(typingOrDialog(window.document.body), false)
    const box = window.document.createElement('div')
    box.setAttribute('role', 'textbox')
    window.document.body.append(box)
    assert.equal(typingOrDialog(box), true)
  } finally {
    Object.defineProperty(globalThis, 'document', { value: previous, configurable: true })
    window.close()
  }
})
