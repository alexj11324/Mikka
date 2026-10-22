import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { typingOrDialog } from './shortcut-guard'

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
