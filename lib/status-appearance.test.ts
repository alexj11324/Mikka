import assert from 'node:assert/strict'
import test from 'node:test'
import { statusTone, statusTones, statusDots } from './status-appearance'
import { ISSUE_STATUSES, ISSUE_PRIORITIES } from '../components/workspace/issue-properties'

test('任务和项目共用状态语义色', () => {
  for (const [issue, project] of [['doing', 'started'], ['done', 'completed'], ['canceled', 'offTrack']]) {
    assert.equal(statusTone(issue), statusTone(project))
  }
  assert.equal(statusTone('done'), 'success')
  assert.equal(statusTone('canceled'), 'destructive')
  assert.equal(statusTone('unknown'), 'neutral')
})

test('所有任务状态及优先级具有浅底、描边、文字及圆点样式', () => {
  for (const option of [...ISSUE_STATUSES, ...ISSUE_PRIORITIES]) {
    const classes = statusTones[option.tone]
    assert.match(classes, /border-/)
    assert.match(classes, /bg-/)
    assert.match(classes, /text-/)
    assert.ok(statusDots[option.tone])
  }
})
