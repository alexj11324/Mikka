import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, createElement, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import { mobileMessages } from '../lib/messages.ts'
import type { ThreadDeliveryView } from '../../../lib/thread-delivery.ts'

const labels = mobileMessages.IssueThreads
const run = '10000000-0000-4000-8000-000000000001', other = '20000000-0000-4000-8000-000000000002'
const issue = '30000000-0000-4000-8000-000000000003', queued = '40000000-0000-4000-8000-000000000004'
const row = { id: queued, text: 'Queued message', status: 'queued' as const, failureCode: null, requestId: queued }
const view: ThreadDeliveryView = { modes: ['queue', 'steer', 'interrupt'], queued: [row] }
const sends: unknown[] = [], reloads: string[] = []
let reply: () => Promise<unknown>
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
mock.module('react-native', { namedExports: { View: 'div' } })
stub('components/Text.tsx', { Text: ({ accessibilityRole, children }: { accessibilityRole?: string; children: ReactNode }) => createElement('span', { role: accessibilityRole }, children) })
stub('components/GlassButton.tsx', { GlassButton: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) =>
  createElement('button', { disabled, onClick: onPress }, label) })
stub('components/Segmented.tsx', { Segmented: ({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void }) =>
  options.map(item => createElement('button', { key: item.value, 'aria-pressed': value === item.value, onClick: () => onChange(item.value) }, item.label)) })
stub('lib/api.ts', { api: async (path: string, init: { method: string; body: { version: number; action: string; args: unknown[] } }) => {
  assert.equal(path, '/api/rpc'); assert.equal(init.method, 'POST'); assert.equal(init.body.version, 1)
  assert.equal(init.body.action, 'agents.changeQueuedThreadReply'); sends.push(init.body.args); return reply()
} })
const { useThreadDeliveryControls } = await import('../features/chat/components/thread-delivery-controls.tsx')
function Harness({ runId, delivery }: { runId: string; delivery?: ThreadDeliveryView }) {
  const control = useThreadDeliveryControls(runId, issue, delivery, async () => { reloads.push(runId) })
  return createElement('main', { 'data-mode': control.mode }, control.controls)
}
const accepted = (status: string) => ({ version: 1, ok: true, result: { status } })
async function mount() {
  const win = new Window()
  Object.assign(globalThis, { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div'), root = createRoot(host)
  const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent === label)
  const render = (runId: string, delivery: ThreadDeliveryView) => act(async () => root.render(createElement(Harness, { runId, delivery })))
  sends.length = 0; reloads.length = 0
  await render(run, view)
  return { host, button, render, click: (label: string) => act(async () => { const item = button(label); assert.ok(item, label); item.click() }),
    close: async () => { await act(async () => root.unmount()); await win.happyDOM.close() } }
}

test('mounted queue controls serialize conflicting actions and discard the old run’s late claim receipt', async () => {
  const ui = await mount()
  try {
    let resolve!: (answer: unknown) => void
    reply = () => new Promise(done => { resolve = done })
    await act(async () => { ui.button(labels.deliveryCancel)!.click(); ui.button(labels.deliverySendNow)!.click() })
    assert.deepEqual(sends, [[{ issueId: issue, runId: run, messageId: queued, action: 'cancel' }]])
    assert.equal(ui.button(labels.deliverySendNow)?.disabled, true)
    await ui.render(other, view)
    assert.equal(ui.button(labels.deliverySendNow)?.disabled, false)
    await act(async () => resolve(accepted('tooLate')))
    assert.equal(ui.host.querySelector('[role=alert]'), null); assert.deepEqual(reloads, [])
    reply = async () => accepted('tooLate'); await ui.click(labels.deliverySendNow)
    assert.equal(ui.host.querySelector('[role=alert]')?.textContent, labels.deliveryTooLate)
    assert.deepEqual(reloads, [other]); assert.deepEqual(sends.at(-1), [{ issueId: issue, runId: other, messageId: queued, action: 'sendNow' }])
  } finally { await ui.close() }
})

test('native delivery modes follow live capabilities, and denial or an opposite-action receipt cannot confirm the selected mutation', async () => {
  const ui = await mount()
  try {
    assert.equal(ui.host.querySelector('main')?.dataset.mode, 'queue')
    await ui.click(labels.deliveryModes.interrupt); assert.equal(ui.host.querySelector('main')?.dataset.mode, 'interrupt')
    await ui.render(other, { ...view, modes: ['queue'] }); assert.equal(ui.host.querySelector('main')?.dataset.mode, 'queue')
    assert.equal(ui.button(labels.deliverySendNow), undefined); assert.equal(ui.button(labels.deliveryModes.interrupt), undefined)
    reply = async () => { throw new Error('offline') }; await ui.click(labels.deliveryCancel)
    assert.equal(ui.host.querySelector('[role=alert]')?.textContent, mobileMessages.Coordinator.sendUncertain)
    reply = async () => ({ version: 1, ok: true, result: { error: 'runNotFound' } }); await ui.click(labels.deliveryCancel)
    assert.equal(ui.host.querySelector('[role=alert]')?.textContent, mobileMessages.Errors.runNotFound)
    reply = async () => accepted('sent'); await ui.click(labels.deliveryCancel)
    assert.equal(ui.host.querySelector('[role=alert]')?.textContent, mobileMessages.Coordinator.sendUncertain); assert.deepEqual(reloads, [])
    reply = async () => accepted('cancelled'); await ui.click(labels.deliveryCancel)
    assert.equal(ui.host.querySelector('[role=alert]'), null); assert.deepEqual(reloads, [other]); assert.equal(sends.length, 4)
    await ui.render(run, { modes: ['steer'], queued: [{ ...row, status: 'delivering' }] })
    assert.equal(ui.host.querySelector('main')?.dataset.mode, 'steer'); assert.equal(ui.button(labels.deliveryCancel), undefined)
  } finally { await ui.close() }
})
