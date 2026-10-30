import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BOT_MODEL_GROUPS, effectiveModel } from '../lib/settings/bots-api'
import { createMockBotsApi, MOCK_BOTS } from '../lib/settings/bots-mock'

test('model menu is exactly Mikka 默认 / Codex / Claude, default first, no custom entry', () => {
  assert.deepEqual(BOT_MODEL_GROUPS.map(group => group.id), ['mikka', 'codex', 'claude'])
  assert.deepEqual(BOT_MODEL_GROUPS.filter(group => group.isDefault).map(group => group.id), ['mikka'])
  assert.equal(effectiveModel({ defaultModel: null, modelGroups: BOT_MODEL_GROUPS }), 'mikka')
  assert.equal(effectiveModel({ defaultModel: 'claude', modelGroups: BOT_MODEL_GROUPS }), 'claude')
})

test('mock threads match the #434 contract: private rows have no title and no link', async () => {
  const page = await createMockBotsApi().listThreads({ botId: MOCK_BOTS[0].id })
  assert.ok(!page.error)
  for (const thread of page.threads) {
    assert.match(thread.threadId, /^t_[0-9a-f]{32}$/)
    assert.equal(thread.href === null, !thread.canOpen)
  }
  assert.ok(page.threads.some(thread => thread.title === null && !thread.canOpen))
  assert.equal(page.summary.totalThreads, page.threads.length)
})

test('member scenario is read-only; save error leaves stored defaults untouched', async () => {
  assert.equal(createMockBotsApi('member').isAdmin, false)
  const api = createMockBotsApi('saveError')
  assert.ok((await api.updateDefaults({ defaultModel: 'codex' })).error)
  const defaults = await api.getDefaults()
  assert.ok(!defaults.error && defaults.defaultModel === null)
})

test('error and empty scenarios', async () => {
  assert.ok((await createMockBotsApi('error').listBots()).error)
  const empty = await createMockBotsApi('empty').listBots()
  assert.ok(!empty.error && empty.bots.length === 0)
})
