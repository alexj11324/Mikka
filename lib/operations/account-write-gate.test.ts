import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appPermissionKeys, withAppPermissions, type AppPermissionValue } from './app-permission-keys'
import { permissionDecision } from './permission-precedence'
import { accountWriteError, accountWriteOutcome } from './account-write-gate'

/** The three first-class writes, and the app key each one must be governed by (ALE-8). */
const WRITES = [
  { action: 'send_email', app: 'gmail' },
  { action: 'create_calendar_event', app: 'googlecalendar' },
  { action: 'update_calendar_event', app: 'googlecalendar' },
] as const

/** What a workspace page stores when an admin picks one access level for `app`. */
const stored = (app: string, value: AppPermissionValue | null) => withAppPermissions({}, [app], value)

/** The setting one first-class write resolves from that stored policy, as
 * lib/operations/account-write-setting.ts reads it: the keys the action and its
 * app carry, restrictive-wins. */
const settingFor = (permissions: Record<string, unknown>, action: string, app: string) =>
  permissionDecision(appPermissionKeys(app).flatMap(key => Object.hasOwn(permissions, key) ? [permissions[key] as AppPermissionValue] : []))

test('each first-class write resolves the workspace choice saved for its app', () => {
  // Without these three entries in the key map the action resolved to nothing and the Coordinator sent anyway.
  for (const { action, app } of WRITES) {
    assert.deepEqual(appPermissionKeys(app).includes(action), true, `${action} is a key of ${app}`)
    assert.equal(settingFor(stored(app, 'deny'), action, app), 'deny', action)
    assert.equal(settingFor(stored(app, 'ask'), action, app), 'ask', action)
    assert.equal(settingFor(stored(app, 'allow'), action, app), 'allow', action)
    // The workspace page clearing the row (Default) leaves the app unset: nothing names the call.
    assert.equal(settingFor(stored(app, null), action, app), null, action)
  }
})

test('a deny stored only under the first-class action still governs its app', () => {
  // Rows written before the page saved both keys (or by an older client) hold only the action key.
  for (const { action, app } of WRITES) {
    assert.equal(settingFor({ [action]: 'deny' }, action, app), 'deny', action)
    assert.equal(settingFor({ [action]: 'ask' }, action, app), 'ask', action)
  }
})

test('deny refuses, ask cards and allow skips the judge — for all three first-class writes', async () => {
  for (const { action, app } of WRITES) {
    // deny: nothing runs, and the judge is never consulted (a deny is absolute).
    const denied = await accountWriteOutcome('deny', async () => { throw new Error(`judged ${action}`) })
    assert.equal(denied, 'deny', action)
    assert.deepEqual(accountWriteError(denied), { error: 'integrationActionDenied' }, action)

    // ask: a card, also without the judge.
    const asked = await accountWriteOutcome('ask', async () => { throw new Error(`judged ${action}`) })
    assert.equal(asked, 'ask', action)
    assert.deepEqual(accountWriteError(asked), { error: 'integrationApprovalRequired' }, action)

    // allow: the workspace's grant is real, so the judge is never asked and the call runs.
    let judged = false
    const allowed = await accountWriteOutcome('allow', async () => { judged = true; return 'ask' })
    assert.equal(allowed, 'run', action)
    assert.equal(judged, false, `${action}: allow never consults the judge`)
    assert.equal(accountWriteError(allowed), null, action)
  }
})

test('an unset workspace choice reaches the judge, whose ask cards and whose allow runs', async () => {
  assert.equal(await accountWriteOutcome(null, async () => 'ask'), 'ask')
  assert.equal(await accountWriteOutcome(null, async () => 'allow'), 'run')
})
