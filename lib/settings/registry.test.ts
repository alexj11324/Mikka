import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSettingsPatch, resolveSettingValue, settingsSchema } from './registry'
import { keyboardShortcutConflicts, normalizeKeyboardShortcut } from '@mikka/protocol/keyboard-shortcuts'

test('inheritance retains explicit zero/empty overrides and falls through null to workspace or default', () => {
  assert.deepEqual(resolveSettingValue('archiveIdleAfterDays', 0, 7), { value: 0, source: 'personal' })
  assert.deepEqual(resolveSettingValue('archiveIdleAfterDays', null, 7), { value: 7, source: 'workspace' })
  assert.deepEqual(resolveSettingValue('archiveIdleAfterDays', null, null), { value: 30, source: 'default' })
  assert.deepEqual(resolveSettingValue('threadTitleInstructions', '', 'team'), { value: '', source: 'personal' })
  assert.deepEqual(resolveSettingValue('subagentMaxConcurrent', 20, null), { value: 6, source: 'default' })
})

test('server guards reject unknown fields, invalid scope, coercion and out-of-range values', () => {
  for (const values of [{ archiveIdleAfterDays: '7' }, { archiveIdleAfterDays: 4 }, { unknown: true }, { toString: 'x' }, { subagentMaxConcurrent: 3 }]) {
    assert.throws(() => parseSettingsPatch('personal', { values }))
  }
  for (const value of [0, 21, 1.5, '6', true]) assert.throws(() => parseSettingsPatch('workspace', { values: { subagentMaxConcurrent: value } }))
  assert.throws(() => parseSettingsPatch('personal', { userId: 'other', values: { archiveIdleAfterDays: 7 } }))
  assert.deepEqual(parseSettingsPatch('personal', { values: { archiveIdleAfterDays: null, threadTitleInstructions: '  own  ' } }),
    { archiveIdleAfterDays: null, threadTitleInstructions: 'own' })
})

test('public schema is serializable metadata with bilingual row search and no server guard', () => {
  const schema = JSON.parse(JSON.stringify(settingsSchema()))
  const row = schema.find((value: { key: string }) => value.key === 'archiveIdleAfterDays')
  assert.equal(row.label['zh-CN'], '归档闲置线程')
  assert.equal(row.page, 'threads')
  assert.ok(row.keywords.includes('archive'))
  assert.equal('guard' in row, false)
  assert.deepEqual(row.writeAccess, { personal: 'owner', workspace: 'admin' })
})

test('keyboard bindings normalize aliases and physical keys while preserving navigation and disabling explicitly', () => {
  assert.equal(normalizeKeyboardShortcut(' shift + commandorcontrol + k '), 'Mod+Shift+KeyK')
  assert.equal(normalizeKeyboardShortcut('ctrl+,'), 'Ctrl+Comma')
  assert.equal(normalizeKeyboardShortcut('Command+F12'), 'Meta+F12')
  assert.equal(normalizeKeyboardShortcut(''), '')
  for (const value of ['Mod', 'Mod+Mod+K', 'Mod+Control+K', 'Mod++', 'Hyper+K', 'toString+K', '__proto__', 'constructor', 'Escape', 'Shift+Tab', 'ArrowDown', 'Shift+ArrowLeft']) {
    assert.equal(normalizeKeyboardShortcut(value), null, value)
  }
  assert.deepEqual(parseSettingsPatch('personal', { values: { 'keyboardShortcuts.search.open': 'ctrl+k', 'keyboardShortcuts.theme.toggle': '' } }),
    { 'keyboardShortcuts.search.open': 'Ctrl+KeyK', 'keyboardShortcuts.theme.toggle': '' })
  assert.throws(() => parseSettingsPatch('workspace', { values: { 'keyboardShortcuts.search.open': 'Mod+K' } }))
  assert.throws(() => parseSettingsPatch('personal', { values: { 'keyboardShortcuts.unknown': 'Mod+K' } }))
  assert.throws(() => parseSettingsPatch('personal', { values: { 'keyboardShortcuts.search.open': { binding: 'Mod+K' } } }))
})

test('keyboard conflicts include untouched defaults and platform aliases but allow mutually exclusive surfaces', () => {
  assert.deepEqual(keyboardShortcutConflicts({}), [])
  assert.deepEqual(keyboardShortcutConflicts({ 'task.create': 'Mod+KeyK' }), [{
    actions: ['search.open', 'task.create'], bindings: ['Mod+KeyK', 'Mod+KeyK'], platforms: ['apple', 'other'],
  }])
  assert.deepEqual(keyboardShortcutConflicts({ 'task.create': 'Ctrl+KeyK' })[0].platforms, ['other'])
  assert.deepEqual(keyboardShortcutConflicts({ 'task.create': 'Meta+KeyK' })[0].platforms, ['apple'])
  assert.deepEqual(keyboardShortcutConflicts({ 'search.open': '', 'task.create': 'Mod+KeyK' }), [])
  assert.deepEqual(keyboardShortcutConflicts({ 'board.assistant.toggle': 'Mod+F2', 'details.toggle': 'Mod+F2', 'devices.add': 'Mod+F2' }), [])
  assert.deepEqual(keyboardShortcutConflicts({ 'task.create': 'Mod+F2', 'board.assistant.toggle': 'Mod+F2' })[0].actions, ['task.create', 'board.assistant.toggle'])
})

test('shortcut schema rows carry stable action IDs, bilingual search, context and default source', () => {
  const row = settingsSchema().find(field => field.action === 'devices.add')!
  assert.equal(row.key, 'keyboardShortcuts.devices.add')
  assert.equal(row.page, 'shortcuts'); assert.equal(row.group, 'keyboard_shortcuts')
  assert.equal(row.label['zh-CN'], '添加设备'); assert.ok(row.keywords.includes('computer'))
  assert.deepEqual(row.context, { scope: 'devices', editable: true, modal: true })
  assert.deepEqual(row.scope, ['personal']); assert.deepEqual(row.writeAccess, { personal: 'owner' })
  assert.deepEqual(resolveSettingValue(row.key, null, 'Mod+F3'), { value: 'Mod+KeyN', source: 'default' })
  assert.deepEqual(resolveSettingValue(row.key, '', null), { value: '', source: 'personal' })
})
