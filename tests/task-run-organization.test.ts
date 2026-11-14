import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readConversationOrganization, regenerateConversationTitle, renameConversation, setConversationOrganization } from '../app/actions/task-runs'

test('conversation organization stays on the installation and is not stored yet', async () => {
  assert.equal(await readConversationOrganization('run-1'), null)
  assert.equal(await setConversationOrganization('run-1', { field: 'pinned', value: true }), null)
  assert.deepEqual(await regenerateConversationTitle('run-1'), { regenerated: false })
  assert.deepEqual(await renameConversation('run-1', 'A new title'), { error: 'unavailable' })
})
