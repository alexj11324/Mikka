import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, beforeEach, mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentProfile } from '../../lib/factory/agent-profile-definition'
import type { AgentProfilesView, ProfileAvailability } from '../settings/factory-profiles-data'

const workspaceId = randomUUID()
const translate = (key: string) => key
mock.module('next-intl', { namedExports: { useTranslations: () => translate } })
// Inspect the real picker/notice through a noninteractive projection of Select
// disabled props. Popup interaction and layout stay in the production-build capture.
let changeValue: (value: string) => void
mock.module(new URL('../ui/select.tsx', import.meta.url).href, { namedExports: {
  Select: ({ children, onValueChange }: { children: ReactNode; onValueChange: (value: string) => void }) => { changeValue = onValueChange; return <div>{children}</div> },
  SelectValue: () => <span />,
  SelectTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ value, disabled, children }: { value: string; disabled?: boolean; children: ReactNode }) => <span data-value={value} data-disabled={disabled === true}>{children}</span>,
  SelectGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>, SelectSeparator: () => null,
} })
let TaskProfilePicker: typeof import('./task-profile-picker')['TaskProfilePicker']
let TaskProfileNotice: typeof import('./task-profile-picker')['TaskProfileNotice']
let taskProfileSelectable: typeof import('../settings/factory-profiles-data')['taskProfileSelectable']
let data: AgentProfilesView | undefined
const choices: Array<string | null> = []
const profile = (name: string): AgentProfile => ({ id: randomUUID(), name, description: '', roles: [name], icon: 'chevrons', color: 'teal', harness: 'codex', model: { mode: 'inherit' }, enabled: true, instructions: '', skills: [], version: 1, digest: 'a'.repeat(64), createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z', archivedAt: null })
const view = (state: ProfileAvailability): AgentProfilesView => {
  const profiles = ['Frontend', 'Backend', 'Review'].map(profile)
  return { profiles, catalog: { models: [], skills: [] }, defaultAvailability: { ...state }, availability: Object.fromEntries(profiles.map(item => [item.id, { ...state }])) }
}
before(async () => { ({ TaskProfilePicker, TaskProfileNotice } = await import('./task-profile-picker')); ({ taskProfileSelectable } = await import('../settings/factory-profiles-data')) }, { timeout: 10_000 })
beforeEach(() => { choices.length = 0; data = view({ available: true }) })
let markup = ''
const render = (value: string | null = null, error?: unknown) => {
  markup = renderToStaticMarkup(<><TaskProfilePicker workspaceId={workspaceId} data={data} value={value} onChange={id => choices.push(id)} />
    <TaskProfileNotice data={data} value={value} error={error} onRetry={() => {}} /></>)
  return markup
}
const optionDisabled = (id: string) => {
  const tag = markup.match(new RegExp(`<span[^>]*data-value="${id}"[^>]*>`))?.[0]
  assert.ok(tag, id)
  return /data-disabled="true"/.test(tag)
}

test('checking Default and custom Profiles remain selectable without claiming allowance is available', () => {
  data = view({ available: false, reason: 'checking' }); const before = structuredClone(data)
  render()
  for (const id of ['default', ...data.profiles.map(item => item.id)]) {
    assert.equal(optionDisabled(id), false, 'checking is pending authorization, not a confirmed refusal')
    changeValue(id); assert.equal(choices.at(-1), id, 'the selection remains an exact structured Profile reference')
    const body = render(id)
    assert.doesNotMatch(body, /role="alert"/)
    assert.match(body, /role="status"[^>]*>reasons.checking/)
  }
  assert.deepEqual(data, before)
})

test('a selected checking Profile has a neutral pending status, not a blocking alert', () => {
  data = view({ available: false, reason: 'checking' })
  const body = render(data.profiles[0].id)
  assert.doesNotMatch(body, /role="alert"/)
  assert.match(body, /role="status"[^>]*>reasons.checking/)
})

test('confirmed refusals, disabled and archived Profiles remain unselectable', () => {
  for (const reason of ['quota', 'expired', 'paused', 'missing', 'noDevice', 'cloudNotConfigured', 'pinConflict', 'skillsChanged', 'providerUnavailable', 'disabled', 'archived', 'unknown_reason']) {
    data = view({ available: false, reason })
    if (reason === 'disabled') data.profiles[0].enabled = false
    if (reason === 'archived') data.profiles[0].archivedAt = '2026-11-05T00:01:00Z'
    const body = render(data.profiles[0].id)
    for (const id of ['default', ...data.profiles.map(item => item.id)]) assert.equal(optionDisabled(id), true, reason)
    assert.match(body, /role="alert"/, reason)
    assert.doesNotMatch(body, /role="status"/)
  }
})

test('missing availability remains blocked while Automatic and read-error recovery remain reachable', () => {
  data = undefined
  const body = render('default', new Error('fixture unavailable'))
  assert.equal(optionDisabled('default'), true); assert.equal(optionDisabled('auto'), false)
  assert.match(body, /loadFailed/); assert.match(body, /retry/)
})

test('confirmed availability preserves ordinary explicit selection, Default inheritance and Automatic', () => {
  const body = render('default')
  assert.equal(optionDisabled('default'), false); assert.doesNotMatch(body, /role="(?:status|alert)"/)
  changeValue('default'); changeValue(data!.profiles[0].id); changeValue('auto')
  assert.deepEqual(choices, ['default', data!.profiles[0].id, null])
})

test('the shared form gate admits checking only for an existing enabled role and preserves metadata refusals', () => {
  for (const state of [{ available: true }, { available: false, reason: 'checking' }]) {
    data = view(state)
    for (const id of ['default', ...data.profiles.map(item => item.id)]) assert.equal(taskProfileSelectable(id, data), true)
    const selected = data.profiles[0]
    selected.enabled = false; render(selected.id)
    assert.equal(taskProfileSelectable(selected.id, data), false); assert.equal(optionDisabled(selected.id), true)
    assert.match(markup, /role="alert"[^>]*>reasons.disabled/)
    selected.archivedAt = '2026-11-05T00:01:00Z'; render(selected.id)
    assert.equal(taskProfileSelectable(selected.id, data), false); assert.equal(optionDisabled(selected.id), true)
    assert.match(markup, /role="alert"[^>]*>reasons.archived/, 'archive takes precedence even when disabled')
    selected.enabled = true; render(selected.id)
    assert.equal(taskProfileSelectable(selected.id, data), false); assert.equal(optionDisabled(selected.id), true)
    assert.match(markup, /role="alert"[^>]*>reasons.archived/)
    assert.equal(taskProfileSelectable(randomUUID(), data), false)
  }
  for (const reason of ['quota', 'expired', 'paused', 'missing', 'noDevice', 'unknown_reason']) {
    data = view({ available: false, reason })
    for (const id of ['default', ...data.profiles.map(item => item.id)]) assert.equal(taskProfileSelectable(id, data), false, reason)
  }
  assert.equal(taskProfileSelectable('default', undefined), false)
  assert.equal(taskProfileSelectable(randomUUID(), undefined), false)
  assert.equal(taskProfileSelectable(null, undefined), true)
  assert.equal(taskProfileSelectable(undefined, undefined), true)
})
