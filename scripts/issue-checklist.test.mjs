import test from 'node:test'
import assert from 'node:assert/strict'
import { issueChecklist } from '../lib/issue-checklist.ts'

test('empty document has no invented checklist progress', () => {
  assert.deepEqual(issueChecklist({ type: 'doc', content: [{ type: 'paragraph' }] }), { total: 0, checked: 0, percentage: 0 })
})
test('nested checklist items count only persisted boolean completion', () => {
  const content = { type: 'doc', content: [{ type: 'taskList', content: [
    { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false } }] }] },
    { type: 'taskItem', attrs: { checked: 'true' } },
  ] }] }
  assert.deepEqual(issueChecklist(content), { total: 3, checked: 1, percentage: 33 })
})
test('completed checklist reports one hundred percent', () => {
  assert.deepEqual(issueChecklist({ type: 'doc', content: [{ type: 'taskItem', attrs: { checked: true } }, { type: 'taskItem', attrs: { checked: true } }] }), { total: 2, checked: 2, percentage: 100 })
})
