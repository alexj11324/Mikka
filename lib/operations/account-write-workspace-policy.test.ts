import assert from 'node:assert/strict'
import test from 'node:test'
import { withAppPermissions } from './app-permission-keys'
import { appCallSetting, toolSettingKey, type AppToolDecision } from '@/lib/app-tools'
import { COMPOSIO_ACTIONS, type ApprovalActionName } from '@/lib/composio-actions'
import { accountWriteError, accountWriteOutcome } from './account-write-gate'

/**
 * The three first-class writes that were outside the workspace's app policy
 * (ALE-8): Gmail set to 不允许 blocked `call_app_tool(GMAIL_*)` while the
 * Coordinator's `send_email` still sent, because
 * lib/operations/app-permission-keys.ts carried none of these actions.
 *
 * `writeAccountAction` resolves one setting from the workspace layer
 * (`{ workspace: external_write_permissions }`, lib/operations/write-setting-layers.ts)
 * with `appCallSetting(layers, toolSettingKey(action), toolkit)` — the same call
 * lib/operations/account-write-setting.ts makes — and `accountWriteOutcome`
 * turns it into refuse / card / run. This runs that exact resolution over a
 * policy the settings page really saves, so deny, ask and allow are covered for
 * each of the three actions without a database.
 */
const WRITES = ['send_email', 'create_calendar_event', 'update_calendar_event'] as const satisfies readonly ApprovalActionName[]
/** The app each write acts in (lib/composio-actions), i.e. the workspace key the page saves. */
const app = (action: ApprovalActionName) => COMPOSIO_ACTIONS[action].toolkit

/** A policy as 设置 › 应用与运行权限 stores it for one app choice. */
const saved = (action: ApprovalActionName, value: 'allow' | 'ask' | 'deny' | null) => ({ workspace: withAppPermissions({}, [app(action)], value) })

/** The setting lib/operations/account-write-setting.ts resolves for this write. */
const setting = (action: ApprovalActionName, layers: { workspace: unknown } | null): AppToolDecision | null =>
  appCallSetting(layers, toolSettingKey(action), app(action))

/** The outcome the gate produces for a resolved setting, recording whether the judge was asked. */
async function outcome(action: ApprovalActionName, layers: { workspace: unknown } | null) {
  const judged: string[] = []
  const value = await accountWriteOutcome(setting(action, layers), async () => { judged.push(action); return 'ask' })
  return { value, judged, error: accountWriteError(value) }
}

test('each first-class write resolves the app choice the workspace page saves, including Default', () => {
  for (const action of WRITES) {
    assert.equal(setting(action, saved(action, 'deny')), 'deny', action)
    assert.equal(setting(action, saved(action, 'ask')), 'ask', action)
    assert.equal(setting(action, saved(action, 'allow')), 'allow', action)
    // Default clears every key of the app, so nothing names the write and the judge decides.
    assert.equal(setting(action, saved(action, null)), null, action)
    // No workspace (a caller with no Bot) reads as unset, not as a refusal.
    assert.equal(setting(action, null), null, action)
  }
})

test('deny refuses, ask cards, allow runs without the judge — each for send_email, create_calendar_event and update_calendar_event', async () => {
  for (const action of WRITES) {
    const denied = await outcome(action, saved(action, 'deny'))
    assert.equal(denied.value, 'deny', action)
    assert.deepEqual(denied.error, { error: 'integrationActionDenied' }, action)
    assert.deepEqual(denied.judged, [], `${action}: a workspace deny is absolute, so the judge is never asked`)

    const asked = await outcome(action, saved(action, 'ask'))
    assert.equal(asked.value, 'ask', action)
    assert.deepEqual(asked.error, { error: 'integrationApprovalRequired' }, action)
    assert.deepEqual(asked.judged, [], `${action}: the card comes from the setting, not from the judge`)

    const allowed = await outcome(action, saved(action, 'allow'))
    assert.equal(allowed.value, 'run', action)
    assert.equal(allowed.error, null, action)
    assert.deepEqual(allowed.judged, [], `${action}: the workspace's Allow is a real grant, so the judge is skipped`)

    // Unset is the only case that reaches the judge; its own ask still cards.
    const unset = await outcome(action, saved(action, null))
    assert.equal(unset.value, 'ask', action)
    assert.deepEqual(unset.judged, [action], action)
  }
})

test('a Gmail deny withholds send_email and does not reach the calendar app', async () => {
  // The reported bug: this policy blocked call_app_tool(GMAIL_*) but not the Coordinator's send_email.
  const gmailDenied = saved('send_email', 'deny')
  assert.deepEqual((await outcome('send_email', gmailDenied)).error, { error: 'integrationActionDenied' })
  assert.equal((await outcome('create_calendar_event', gmailDenied)).value, 'ask', 'a Gmail deny names nothing for Calendar')
  // And the Calendar deny covers both of its actions.
  const calendarDenied = saved('create_calendar_event', 'deny')
  for (const action of ['create_calendar_event', 'update_calendar_event'] as const) {
    assert.equal((await outcome(action, calendarDenied)).value, 'deny', action)
  }
  assert.equal((await outcome('send_email', calendarDenied)).value, 'ask', 'a Calendar deny names nothing for Gmail')
})

test('a setting stored only under an action key still governs that write', async () => {
  // Rows written before the page saved every key of the app hold only the action key.
  for (const action of WRITES) {
    assert.equal(setting(action, { workspace: { [action]: 'deny' } }), 'deny', action)
    assert.equal(setting(action, { workspace: { [action]: 'ask' } }), 'ask', action)
  }
})
