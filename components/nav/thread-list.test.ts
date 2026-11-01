import assert from 'node:assert/strict'
import test from 'node:test'

import { issueIdentifier } from '@/components/workspace/issue-properties'
import { threadName } from './thread-list'

const thread = (issueId: string | null, prompt = '') => ({ issueId, prompt }) as Parameters<typeof threadName>[0]
const issue = (identifier: string | null) => ({ id: 'task-1', identifier, title: '登录超时排查' }) as Parameters<typeof threadName>[1][number]

test('a task without an id shows no id and no placeholder word', () => {
  assert.equal(issueIdentifier({ identifier: null }), '')
  assert.equal(threadName(thread('task-1'), [issue(null)], '未命名'), '登录超时排查')
})

test('a task with an id leads its thread name with it', () => {
  assert.equal(issueIdentifier({ identifier: 'MIK-12' }), 'MIK-12')
  assert.equal(threadName(thread('task-1'), [issue('MIK-12')], '未命名'), 'MIK-12 登录超时排查')
})
