import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { installComposerDiagnostics, readComposerDiagnostics } from './composer-diagnostics.mjs'

function renderer() {
  const listeners = new Map(), windowListeners = new Map(), storage = new Map()
  let current, changed
  class Textarea {
    value = ''; disabled = false; readOnly = false; isConnected = true
    matches(selector) { return selector === 'textarea[data-chat-composer]' }
  }
  const context = vm.createContext({
    window: { addEventListener: (name, listener) => windowListeners.set(name, listener) },
    document: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      querySelector: () => current ?? null, querySelectorAll: () => current ? [current] : [],
    },
    HTMLTextAreaElement: Textarea, MutationObserver: class { constructor(listener) { changed = listener } observe() {} },
    performance: { now: () => 1 }, queueMicrotask,
    sessionStorage: { get length() { return storage.size }, key: index => [...storage.keys()][index], getItem: key => storage.get(key) },
  })
  const evaluate = callback => vm.runInContext(`(${callback.toString()})()`, context)
  return {
    storage, Textarea, evaluate,
    mount(node) { current = node; changed?.() },
    input(node) { listeners.get('input')({ target: node }) },
    clear() { windowListeners.get('mikka:clear-view-state')() },
    install() { evaluate(installComposerDiagnostics) },
    read: async () => JSON.parse(JSON.stringify(await readComposerDiagnostics({ evaluate }))),
  }
}

test('a controlled value rollback is distinguished from an input node replacement without disclosing text or scope', async () => {
  const page = renderer(), first = new page.Textarea()
  const privateDraft = 'PRIVATE draft and account@example.test', key = 'mikka:view:v1:private-owner:private-workspace:bot-chat:private-bot:main:draft'
  page.storage.set(key, JSON.stringify(privateDraft))
  page.mount(first); page.install()
  first.value = privateDraft; page.input(first)
  first.value = '' // The observer must retain input-before-controlled-restoration ordering.
  await Promise.resolve()
  let proof = await page.read()
  const input = proof.events.find(event => event.kind === 'input'), restored = proof.events.find(event => event.kind === 'after-input')
  assert.equal(input.eventLength, privateDraft.length)
  assert.equal(restored.eventLength, 0)
  assert.equal(restored.currentNode, input.currentNode)
  assert.equal(restored.connected, true)
  const second = new page.Textarea(); first.isConnected = false; page.mount(second)
  proof = await page.read()
  assert.notEqual(proof.current.currentNode, input.currentNode)
  assert.equal(proof.current.drafts[0].cell, input.drafts[0].cell)
  const encoded = JSON.stringify(proof)
  for (const sensitive of [privateDraft, key, 'private-owner', 'private-workspace', 'private-bot', 'account@example.test']) assert.equal(encoded.includes(sensitive), false)
})

test('input/clear observations retain at most32 closed events and8 anonymous draft cells', async () => {
  const page = renderer(), node = new page.Textarea(); page.mount(node)
  for (let index = 0; index < 50; index++) page.storage.set(`mikka:view:v1:owner-${index}:workspace:bot-chat:coordinator:main:draft`, JSON.stringify(`private-${index}`))
  page.install()
  for (let index = 0; index < 40; index++) { node.value = `private-value-${index}`; page.input(node); await Promise.resolve() }
  page.clear()
  const proof = await page.read()
  assert.equal(proof.events.length, 32)
  assert.ok(proof.dropped > 0)
  assert.equal(proof.events.at(-1).kind, 'clear-view-state')
  assert.equal(proof.current.drafts.length, 8)
  assert.ok(proof.events.every(event => event.drafts.length <= 8))
  assert.equal(JSON.stringify(proof).includes('private-'), false)
  assert.equal(JSON.stringify(proof).includes('owner-'), false)
})

test('an inaccessible renderer returns a fixed unavailable state without transporting its error', async () => {
  assert.deepEqual(await readComposerDiagnostics({ evaluate() { throw Error('private-account-or-browser-handoff-url') } }), { state: 'unavailable' })
})
