import assert from 'node:assert/strict'
import test from 'node:test'
import { newTaskBotChoices } from './new-task-bot'

test('新建任务 offers every bot but the Coordinator, which is the default (T4)', () => {
  const bots = [{ id: 'c', name: 'Coordinator', coordinator: true }, { id: 'f', name: '前端助手' }, { id: 'b', name: '后端值班', coordinator: false }]
  assert.deepEqual(newTaskBotChoices(bots).map(bot => bot.name), ['前端助手', '后端值班'])
  assert.deepEqual(newTaskBotChoices([{ id: 'c', coordinator: true }]), [])
})
