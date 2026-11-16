import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { act, createElement as h, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import { mobileMessages as messages } from '../lib/messages.ts'

const browser = new Window()
Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
after(() => browser.happyDOM.close())
const stub = (file: string, namedExports: Record<string, unknown>) =>
  mock.module(new URL('../' + file, import.meta.url).href, { namedExports })
const none = () => null
const group = ({ label, children }: { label?: string; children?: ReactNode }) => h('section', null, label, children)
const paths: string[] = []
const send = mock.fn(async (path: string, init?: { method: string; body?: { label: string } }) =>
  init?.method === 'PATCH' ? { id: path.split('/').at(-1), label: init.body?.label } : { accepted: true })
let registered = false
class ApiError extends Error { constructor(readonly status: number) { super() } }
const read = { loading: true, data: null as { installations: object[] } | null, error: null as Error | null,
  reload: mock.fn(), reloadAfterWrite: mock.fn() }
mock.module('react-native', { namedExports: { View: 'div',
  TextInput: ({ accessibilityLabel, value, onChangeText }: { accessibilityLabel: string; value: string; onChangeText: (value: string) => void }) =>
    h('input', { 'aria-label': accessibilityLabel, value, onInput: (event: { currentTarget: { value: string } }) => onChangeText(event.currentTarget.value), onChange: none }),
} })
stub('components/settings.tsx', { SettingsPage: group, ToggleRow: none,
  Row: ({ label, detail, value, onPress, disabled }: { label: string; detail?: string; value?: string; onPress?: () => void; disabled?: boolean }) =>
    onPress ? h('button', { onClick: onPress, disabled }, label, detail) : h('p', null, label, detail, value) })
stub('lib/theme.ts', { colors: {}, font: undefined })
stub('components/ui.tsx', { Group: group })
stub('components/PushRow.tsx', { PushRow: none })
stub('components/PreferenceSaveNotice.tsx', { PreferenceSaveNotice: none })
stub('components/icons.tsx', { Spinner: () => h('span', { role: 'status' }) })
stub('components/ReadNotice.tsx', { ReadNotice: ({ error, onRetry }: { error: unknown; onRetry: () => void }) =>
  error ? h('button', { onClick: onRetry }, messages.Common.retry) : null })
stub('lib/settings.tsx', { useSettings: () => ({ data: { preferences: {} }, preferenceSave: { status: 'idle' } }) })
stub('lib/api.ts', { ApiError, api: send, apiConnection: () => ({}) })
stub('lib/push-state.ts', { askForPush: none, usePushState: () => registered ? 'registered' : 'undetermined' })
stub('lib/useApi.ts', { useApi: (path: string) => { paths.push(path); return read } })

const { createRoot } = await import('react-dom/client')
const { default: NotificationsScreen } = await import('../app/(tabs)/settings/notifications.tsx')

test('Notification settings reads active push devices, refreshes after registration and distinguishes failed and empty reads', async () => {
  const root = createRoot(document.body)
  const render = () => act(async () => root.render(h(NotificationsScreen)))
  const contents = () => document.body.textContent ?? ''
  const copy = messages.MobileCore.notifications
  try {
    await render()
    assert.ok(document.querySelector('[role="status"]'))
    assert.ok(!contents().includes(copy.noRegisteredDevices))
    read.loading = false
    read.data = { installations: [] }
    await render()
    assert.ok(contents().includes(copy.noRegisteredDevices))
    registered = true
    await render()
    await render()
    assert.equal(read.reloadAfterWrite.mock.callCount(), 1)
    read.data = { installations: [
      { id: 'first', platform: 'ios', deviceName: 'Pocket', currentSession: true, updatedAt: '2026-01-02T12:00:00Z' },
      { id: 'other', platform: 'android', deviceName: null, currentSession: false, updatedAt: '2026-01-01T12:00:00Z' },
    ] }
    read.error = new Error('offline')
    await render()
    const rows = Array.from(document.querySelectorAll('p'), node => node.textContent)
    assert.ok(rows[0]?.includes('Pocket') && rows[0].includes('iOS') && rows[0].includes(messages.Settings.profile.currentSession))
    assert.ok(rows[1]?.includes('Android') && !rows[1].includes(messages.Settings.profile.currentSession))
    await act(async () => document.querySelector('button')!.click())
    assert.equal(read.reload.mock.callCount(), 1)
    assert.ok(!contents().includes(copy.testDevice), 'older directory responses have no test capability')
    read.error = null
    read.data = { installations: [
      { id: 'first', platform: 'ios', deviceName: 'Pocket', currentSession: true, canTest: true, updatedAt: '2026-01-02T12:00:00Z' },
      { id: 'peer', platform: 'android', deviceName: null, currentSession: false, canTest: false, updatedAt: '2026-01-01T12:00:00Z' },
    ] }
    await render()
    assert.equal(document.querySelectorAll('button').length, 1)
    await act(async () => document.querySelector('button')!.click())
    assert.deepEqual(send.mock.calls.map(call => call.arguments[0]), ['/api/mobile/push-tokens/first/test'])
    assert.ok(contents().includes(copy.testAccepted))
    assert.ok(!contents().includes(copy.renameDevice))
    read.data = { installations: [
      { id: 'first', platform: 'ios', label: 'Primary', deviceName: 'Pocket', currentSession: true, canRename: true, updatedAt: '2026-01-02T12:00:00Z' },
      { id: 'peer', platform: 'android', deviceName: 'Other', currentSession: false, canRename: false, updatedAt: '2026-01-01T12:00:00Z' },
    ] }
    await render()
    assert.ok(contents().includes('Primary') && !contents().includes('Pocket'))
    const button = (label: string) => Array.from(document.querySelectorAll('button')).find(node => node.textContent === label)!
    assert.equal(document.querySelectorAll('button').length, 1)
    await act(async () => button(copy.renameDevice).click())
    const input = document.querySelector('input')!
    assert.equal(input.value, 'Primary')
    const change = (label: string) => act(async () => {
      input.value = label
      input.dispatchEvent(new browser.Event('input', { bubbles: true }))
    })
    await change(' ')
    assert.equal(button(messages.Common.save).disabled, true)
    await change('Office')
    await act(async () => button(messages.Common.save).click())
    assert.deepEqual(send.mock.calls.at(-1)?.arguments.slice(0, 2), ['/api/mobile/push-tokens/first', { method: 'PATCH', body: { label: 'Office' } }])
    assert.equal(read.reloadAfterWrite.mock.callCount(), 2)
    assert.equal(document.querySelector('input'), null)
    read.data = null
    read.error = new ApiError(405)
    await render()
    assert.ok(!contents().includes(copy.registeredDevices))
    assert.deepEqual([...new Set(paths)], ['/api/mobile/push-tokens'])
  } finally { await act(async () => root.unmount()) }
})
