import assert from 'node:assert/strict'
import test from 'node:test'
import { BOT_MODEL_GROUPS, BOT_THREAD_TITLE_MAX, botThreadsInput, botThreadTitle, decodeBotThreadCursor, encodeBotThreadCursor } from './bot-threads'

test('model menu is three families in order: Mikka 默认 / Codex / Claude', () => {
  assert.deepEqual(BOT_MODEL_GROUPS.map(group => [group.id, group.source, group.isDefault]), [['mikka', 'hosted', true], ['codex', 'subscription', false], ['claude', 'subscription', false]])
  assert.deepEqual(BOT_MODEL_GROUPS.map(group => group.labelKey), ['Settings.bots.models.mikka', 'Settings.bots.models.codex', 'Settings.bots.models.claude'])
})

test('cursor round-trips and rejects anything foreign', () => {
  const position = { createdAt: '2026-10-29T12:00:00.123456Z', id: '00000000-0000-4000-8000-000000000001' }
  assert.deepEqual(decodeBotThreadCursor(encodeBotThreadCursor(position)), position)
  for (const bad of ['', 'not base64!', Buffer.from('{"createdAt":"x","id":"y"}').toString('base64url'), Buffer.from(JSON.stringify({ ...position, extra: 1 })).toString('base64url'), 'a'.repeat(201)]) {
    assert.equal(decodeBotThreadCursor(bad), null, bad)
  }
})

test('input: uuid bot, limit 1..50 default 20, strict', () => {
  assert.equal(botThreadsInput.parse({ botId: '00000000-0000-4000-8000-000000000001' }).limit, 20)
  for (const bad of [{ botId: 'x' }, { botId: '00000000-0000-4000-8000-000000000001', limit: 51 }, { botId: '00000000-0000-4000-8000-000000000001', limit: 0 }, { botId: '00000000-0000-4000-8000-000000000001', extra: 1 }]) {
    assert.equal(botThreadsInput.safeParse(bad).success, false)
  }
})

test('titles follow visibility: task title if visible, prompt only to its starter, else null', () => {
  assert.equal(botThreadTitle({ issueTitle: '修复登录页的 OAuth 回调', issueVisible: true, prompt: 'secret', startedByViewer: false }), '修复登录页的 OAuth 回调')
  assert.equal(botThreadTitle({ issueTitle: 'Private task', issueVisible: false, prompt: 'p', startedByViewer: true }), null)
  assert.equal(botThreadTitle({ issueTitle: null, issueVisible: false, prompt: '\n  first line \nsecond', startedByViewer: true }), 'first line')
  assert.equal(botThreadTitle({ issueTitle: null, issueVisible: false, prompt: 'someone else', startedByViewer: false }), null)
  assert.equal(botThreadTitle({ issueTitle: null, issueVisible: false, prompt: '   ', startedByViewer: true }), null)
  const long = botThreadTitle({ issueTitle: '长'.repeat(200), issueVisible: true, prompt: '', startedByViewer: false })!
  assert.equal(Array.from(long).length, BOT_THREAD_TITLE_MAX)
  assert.ok(long.endsWith('…'))
})
