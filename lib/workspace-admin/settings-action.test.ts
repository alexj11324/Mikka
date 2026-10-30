import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { WorkspaceError } from '@/lib/workspace-access'
import { settingsWorkspaceAction, SETTINGS_ACTION_ERROR_CODES } from './settings-action'

test('settings actions preserve the backend business codes without adding UI messages', async () => {
  for (const code of SETTINGS_ACTION_ERROR_CODES) {
    assert.deepEqual(await settingsWorkspaceAction(async () => { throw new WorkspaceError(code) }), { error: code })
  }
  assert.deepEqual(await settingsWorkspaceAction(async () => ({ id: 'owned-resource' })), { id: 'owned-resource' })
})
test('settings actions retain auth and validation failures and propagate unexpected errors', async () => {
  assert.deepEqual(await settingsWorkspaceAction(async () => { throw new ActionFailureError('authRequired') }), { error: 'authRequired', params: undefined })
  assert.deepEqual(await settingsWorkspaceAction(async () => z.uuid().parse('bad')), { error: 'validationGeneric' })
  const failure = new Error('unexpected-storage-failure')
  await assert.rejects(settingsWorkspaceAction(async () => { throw failure }), error => error === failure)
})
