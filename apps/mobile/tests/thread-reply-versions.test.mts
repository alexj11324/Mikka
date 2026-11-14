import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, createElement, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import type { ThreadDetail } from '../lib/types.ts'
import { mobileMessages } from '../lib/messages.ts'

const copy = mobileMessages.IssueThreads
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const issueId = id(1), runId = id(2), anchorKey = id(3), oldId = id(4), newId = id(5), resultRunId = id(6)
const originalPr = 'https://github.com/example/repo/pull/1', previousPr = 'https://github.com/example/repo/pull/2'
const previous = { id: oldId, anchorRunId: runId, anchorKey, text: 'Previous input', originalText: 'Original input', resultRunId,
  originalOutput: 'Original immutable reply', output: 'Previous version output', originalPullRequest: originalPr, pullRequest: previousPr }
const writes: { requestId: string; text?: string; operation: string }[] = [], opened: string[] = []
let rows: unknown = [], result: () => Promise<unknown>, reads = 0, issued = 0, reloads = 0
const ok = (value: unknown) => ({ version: 1, ok: true, result: value })
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
class ApiError extends Error { constructor(readonly status: number, message: string) { super(message) } }
mock.module('expo-crypto', { namedExports: { randomUUID: () => id(100 + ++issued) } })
mock.module('react-native', { namedExports: { View: 'div', Linking: { openURL: async (url: string) => { opened.push(url) } },
  TextInput: ({ value, onChangeText }: { value: string; onChangeText: (text: string) => void }) => createElement('textarea', { value, onInput: (e: { currentTarget: { value: string } }) => onChangeText(e.currentTarget.value), onChange: () => {} }) } })
stub('components/Text.tsx', { Text: ({ accessibilityRole, children }: { accessibilityRole?: string; children: ReactNode }) => createElement('span', { role: accessibilityRole }, children) })
stub('components/GlassButton.tsx', { GlassButton: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) =>
  createElement('button', { disabled, onClick: onPress }, label) })
stub('components/Segmented.tsx', { Segmented: ({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (value: string) => void }) =>
  options.map(row => createElement('button', { key: row.value, 'aria-pressed': row.value === value, onClick: () => onChange(row.value) }, row.label)) })
stub('lib/api.ts', { ApiError, api: async (path: string, init: { body: { version: number; action: string; args: any[] } }) => {
  assert.equal(path, '/api/rpc'); assert.equal(init.body.version, 1)
  if (init.body.action === 'agents.getThreadReplyVersions') { reads++; assert.deepEqual(init.body.args, [issueId, runId]); return ok(rows) }
  assert.equal(init.body.action, 'agents.createThreadReplyVersion')
  const command = init.body.args[0]; assert.equal(command.issueId, issueId); assert.equal(command.runId, runId)
  writes.push(command.change); return result()
} })
const { MobileReplyVersions } = await import('../features/chat/components/thread-reply-versions.tsx')
async function mount(operation: 'edit' | 'rerun') {
  const win = new Window()
  Object.assign(globalThis, { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div'), root = createRoot(host)
  const detail = { issueId, versionAnchors: { item: { runId, key: anchorKey, operation } } } as ThreadDetail
  const render = (working: boolean, data: ThreadDetail | undefined = detail) => act(async () => root.render(createElement(MobileReplyVersions,
    { detail: data, runId, itemId: 'item', text: operation === 'edit' ? 'Original input' : 'Original immutable reply', working, reload: async () => { reloads++ } })))
  const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent === label)
  writes.length = 0; opened.length = 0; reads = 0; issued = 0; reloads = 0
  await render(false)
  return { host, render, button, click: (label: string) => act(async () => { assert.ok(button(label), label); button(label)!.click() }),
    close: async () => { await act(async () => root.unmount()); await win.happyDOM.close() } }
}

test('original and historical native replies open only their own output and PR; viewing or switching versions never dispatches', async () => {
  rows = [previous, { ...previous, id: id(8), anchorKey: id(10), output: 'Other anchor' }]
  const ui = await mount('rerun')
  try {
    await ui.click(copy.versionRerun)
    assert.ok(ui.host.textContent?.includes(previous.originalOutput)); await ui.click(copy.versionPullRequest)
    await ui.click(copy.versionNumber.replace('{number}', '2')); assert.ok(ui.host.textContent?.includes(previous.output)); await ui.click(copy.versionPullRequest)
    await ui.click(copy.versionOriginal); assert.ok(ui.host.textContent?.includes(previous.originalOutput))
    assert.deepEqual(opened, [originalPr, previousPr]); assert.equal(reads, 1); assert.deepEqual(writes, []); assert.equal(reloads, 0)
    await ui.render(true); assert.equal(ui.button(copy.versionRun)?.disabled, true)
    await ui.render(false, { issueId: null, versionAnchors: {} } as ThreadDetail); assert.equal(ui.host.textContent, '')
  } finally { await ui.close() }
})

test('rapid taps, a lost mobile write answer and an incomplete read-back retry one original command until the matching run is confirmed', async () => {
  rows = [previous]
  const ui = await mount('edit')
  try {
    await ui.click(copy.versionEdit)
    await act(async () => { const input = ui.host.querySelector('textarea')!; input.value = 'New input'; input.dispatchEvent(new window.Event('input', { bubbles: true })) })
    let fail!: (reason: Error) => void
    result = () => new Promise((_resolve, reject) => { fail = reject })
    await act(async () => { const run = ui.button(copy.versionRun)!; run.click(); run.click() })
    assert.equal(writes.length, 1); assert.equal(writes[0]?.text, 'New input'); assert.equal(writes[0]?.operation, 'edit')
    await act(async () => fail(new Error('network unavailable')))
    assert.ok(ui.host.querySelector('[role=alert]')); assert.equal(reloads, 0)
    result = async () => ok({ versionId: newId, runId: resultRunId })
    await ui.click(copy.versionRun); assert.ok(ui.host.querySelector('[role=alert]')); assert.equal(reloads, 0)
    for (const unconfirmedRunId of [null, id(57)]) {
      rows = [previous, { ...previous, id: newId, text: 'New input', resultRunId: unconfirmedRunId }]
      await ui.click(copy.versionRun)
      assert.ok(ui.host.querySelector('[role=alert]')); assert.equal(reloads, 0)
    }
    rows = [previous, { ...previous, id: newId, text: 'New input', output: 'Saved new output' }]
    await ui.click(copy.versionRun)
    assert.equal(issued, 1); assert.equal(writes.length, 5); assert.ok(writes.every(write => write.requestId === writes[0]!.requestId))
    assert.ok(ui.host.textContent?.includes('Saved new output')); assert.equal(ui.host.querySelector('[role=alert]'), null); assert.equal(reloads, 1)
  } finally { await ui.close() }
})

test('a pending delivery receipt is explained on native without resubmitting or clearing the original reply', async () => {
  rows = [previous]
  result = async () => ok({ error: 'threadSubmissionOutcomeUnconfirmed' })
  const ui = await mount('edit')
  try {
    await ui.click(copy.versionEdit)
    await ui.click(copy.versionRun)
    const message = mobileMessages.Errors.threadSubmissionOutcomeUnconfirmed
    assert.ok(message)
    assert.equal(ui.host.querySelector('[role=alert]')?.textContent, message)
    assert.ok(ui.host.textContent?.includes(previous.originalOutput))
    assert.equal(reloads, 0)
    assert.equal(writes.length, 1)
  } finally { await ui.close() }
})

test('the native picker refuses malformed replies and revoked access without exposing cached versions or confirming a submission', async () => {
  rows = [{ id: oldId }]
  const ui = await mount('edit')
  try {
    await ui.click(copy.versionEdit); assert.ok(ui.host.querySelector('[role=alert]')); assert.equal(ui.button(copy.versionRun)?.disabled, true)
    rows = [previous]; await ui.click(copy.versionClose); await ui.click(copy.versionEdit)
    result = async () => ok({ versionId: newId }); await ui.click(copy.versionRun)
    assert.ok(ui.host.querySelector('[role=alert]')); assert.equal(reloads, 0)
    result = async () => ok({ error: 'runNotFound' }); await ui.click(copy.versionRun)
    assert.equal(ui.button(copy.versionRun)?.disabled, true); assert.equal(ui.button(copy.versionPullRequest), undefined)
    assert.ok(!ui.host.textContent?.includes(previous.originalOutput)); assert.equal(reloads, 0)
  } finally { await ui.close() }
})
