import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveRuntime } from '@/lib/live/channel'
import { LiveChannelOwner } from '@/lib/live/preparation'
import type { DesktopBootstrap } from './bootstrap'
import { isInstalledWorkspacePath, WorkspaceLiveController } from './workspace-live'

const selected = '8d992f67-2388-4372-92eb-410170899f61'
const home = 'a0c73a42-d768-467c-a00a-dc3a03e98273'
const other = '201be533-6e3f-41df-994d-69da822f2db3'
const bootstrap = (): DesktopBootstrap => ({
  user: { id: 'owner', name: 'Fixture', email: 'fixture@example.invalid' },
  session: { id: 'session' }, googleEnabled: false, githubEnabled: false, emailEnabled: true,
  cacheWorkspace: { workspaceId: selected, role: 'member' }, liveHomeWorkspaceId: home,
})
const selection = () => ({ enabled: true, selector: null as string | null, server: 'https://fixture.invalid' })

function fixture() {
  const calls: { scope: string | null; signal: AbortSignal }[] = []
  const runtime = (scope: string | null): LiveRuntime => ({
    ticket: async signal => { calls.push({ scope, signal }); return null },
    socket() { throw new Error('a rejected fixture ticket must not create a socket') },
    visible: () => true, watchVisibility: () => () => {}, now: () => 1_800_000_000_000,
    later() { throw new Error('empty rejected preparations must not schedule retry or fallback') }, cancel() {},
  })
  const controller = new WorkspaceLiveController(runtime)
  return { calls, runtime, controller }
}

test('only the existing InstalledWorkspace render routes are eligible for preparation', () => {
  for (const path of ['/', '/dashboard', '/settings', '/settings/teams', '/settings/members']) assert.equal(isInstalledWorkspacePath(path), true, path)
  for (const path of ['/device', '/devices', '/sign-in', '/sign-up', '/workspaces/new', '/invite/token', '/a/token', '/w/example', '/forgot-password', '/settings/unknown', '/en/', '//']) {
    assert.equal(isInstalledWorkspacePath(path), false, path)
  }
})

test('a fully parsed authorized workspace prepares selected and home once without awaiting ready', () => {
  const f = fixture(), value = bootstrap(), input = selection()
  const prepared = f.controller.reconcile(value, input)
  assert.ok(prepared)
  assert.deepEqual(f.calls.map(call => call.scope), [selected, home])
  assert.equal(f.controller.reconcile(value, input), prepared)
  assert.equal(f.calls.length, 2)
  f.controller.retire()
  assert.equal(prepared.isAuthorityRetired, true)
  assert.ok(f.calls.every(call => call.signal.aborted))
})

test('disabled routes, missing identity and unverified selection do not prepare', () => {
  const cases: { value: DesktopBootstrap; input: ReturnType<typeof selection> }[] = [
    { value: bootstrap(), input: { ...selection(), enabled: false } },
    { value: { ...bootstrap(), user: null }, input: selection() },
    { value: { ...bootstrap(), session: null }, input: selection() },
    { value: { ...bootstrap(), cacheWorkspace: null }, input: selection() },
    { value: { ...bootstrap(), cacheWorkspace: { workspaceId: 'invalid', role: 'member' } }, input: selection() },
    { value: { ...bootstrap(), cacheWorkspace: { workspaceId: '00000000-0000-0000-0000-000000000000', role: 'member' } }, input: selection() },
    { value: bootstrap(), input: { ...selection(), selector: other } },
    { value: bootstrap(), input: { ...selection(), server: '' } },
  ]
  for (const { value, input } of cases) {
    const f = fixture()
    assert.equal(f.controller.reconcile(value, input), undefined)
    assert.equal(f.calls.length, 0)
    f.controller.retire()
  }
})

test('a missing home hint never guesses that the selected workspace is personal home', () => {
  const f = fixture(), value = { ...bootstrap(), liveHomeWorkspaceId: null }
  const prepared = f.controller.reconcile(value, selection())
  assert.ok(prepared)
  assert.deepEqual(f.calls.map(call => call.scope), [selected])
  f.controller.retire()
})

for (const change of ['owner', 'session', 'server', 'selector', 'role', 'workspace', 'home'] as const) test('an authorization or routing change retires the old preparation: ' + change, () => {
  const f = fixture(), old = f.controller.reconcile(bootstrap(), selection())!
  const value = bootstrap(), input = selection()
  if (change === 'owner') value.user = { ...value.user!, id: 'new-owner' }
  if (change === 'session') value.session = { id: 'new-session' }
  if (change === 'server') input.server = 'https://different.invalid'
  if (change === 'selector') input.selector = selected
  if (change === 'role') value.cacheWorkspace = { workspaceId: selected, role: 'admin' }
  if (change === 'workspace') value.cacheWorkspace = { workspaceId: other, role: 'member' }
  if (change === 'home') value.liveHomeWorkspaceId = other
  const next = f.controller.reconcile(value, input)
  assert.ok(next)
  assert.notEqual(next, old)
  assert.equal(old.isAuthorityRetired, true)
  assert.ok(f.calls.slice(0, 2).every(call => call.signal.aborted))
  f.controller.retire()
})

test('an invalid later result revokes the previous preparation instead of retaining its history', () => {
  const f = fixture(), old = f.controller.reconcile(bootstrap(), selection())!
  assert.equal(f.controller.reconcile({ ...bootstrap(), cacheWorkspace: null }, selection()), undefined)
  assert.equal(old.isAuthorityRetired, true)
  assert.equal(f.calls.length, 2)
  f.controller.retire()
})

test('returning to a legal workspace can create a fresh lifetime without reviving retired effects', () => {
  const f = fixture(), value = bootstrap(), input = selection()
  const old = f.controller.reconcile(value, input)!
  const lateOwner = new LiveChannelOwner(f.runtime, new Map(), old)
  f.controller.reconcile(value, { ...input, enabled: false })
  lateOwner.subscribe(selected, 'workspace_settings', selected, ['late'], () => {})
  assert.equal(f.calls.length, 2)
  const next = f.controller.reconcile(value, input)
  assert.ok(next)
  assert.notEqual(next, old)
  assert.equal(next.isAuthorityRetired, false)
  assert.equal(f.calls.length, 4)
  f.controller.retire()
})

test('a provider-retired preparation is replaced even when bootstrap identity is unchanged', () => {
  const f = fixture(), value = bootstrap(), input = selection()
  const old = f.controller.reconcile(value, input)!
  const owner = new LiveChannelOwner(f.runtime, new Map(), old), cleanup = owner.mount()
  cleanup()
  assert.equal(old.isRetired, true)
  assert.equal(old.isAuthorityRetired, false)
  const next = f.controller.reconcile(value, input)
  assert.ok(next)
  assert.notEqual(next, old)
  assert.equal(old.isAuthorityRetired, true)
  f.controller.retire()
})
