import assert from 'node:assert/strict'
import test from 'node:test'
import { advancesTo } from './task-status-advance'

test('a status only advances forward along 待整理 → 待办 → 进行中 → 评审中 → 已完成 (2026-11-13-1405)', () => {
  assert.equal(advancesTo('backlog', 'doing'), true)
  assert.equal(advancesTo('todo', 'doing'), true)
  assert.equal(advancesTo('todo', 'done'), true, 'steps may be skipped')
  assert.equal(advancesTo('doing', 'review'), true)
  assert.equal(advancesTo('review', 'done'), true)
  for (const [from, to] of [['doing', 'doing'], ['review', 'doing'], ['done', 'doing'], ['review', 'review'], ['done', 'review'], ['done', 'done']] as const) assert.equal(advancesTo(from, to), false, `${from} → ${to}`)
  for (const closed of ['canceled', 'duplicate', 'unknown']) for (const to of ['doing', 'review', 'done'] as const) assert.equal(advancesTo(closed, to), false, `${closed} never moves`)
})
