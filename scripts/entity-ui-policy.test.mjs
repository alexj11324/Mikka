import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { auditEntityDetail, auditTaskEntry, verifyEntityContracts } from './entity-ui-policy.mjs'

const entry = 'components/workspace/issue-workspace.tsx'
const lazy = "const Form = dynamic(() => import('./task-detail').then(module => module.TaskDetail))"
test('full page and sidebar both render the actual canonical editor', () => {
  for (const file of [entry, 'components/coordinator/conversation-panels.tsx']) {
    assert.deepEqual(auditTaskEntry(file, readFileSync(file, 'utf8')), [])
  }
  assert.deepEqual(auditTaskEntry(entry, lazy + '; function Page(){return <Form/>}'), [])
  assert.deepEqual(auditTaskEntry(entry, "import { TaskDetail as Editor } from './task-detail'; function Page(){return <Editor/>}"), [])
})
test('copied editor, unused import, type-only binding and independent mutation fail', () => {
  for (const code of [lazy + '; function Page(){return <Other/>}', lazy.replace('./task-detail', './copy') + '; const view = <Form/>',
    "import type { TaskDetail } from './task-detail'; const view = <TaskDetail/>"]) {
    assert.equal(auditTaskEntry(entry, code)[0].rule, 'entity/task-editor-entry')
  }
  assert.equal(auditTaskEntry(entry, lazy + "; import { saveIssue as update } from '@/app/actions/issues'; const view = <Form/>")[0].rule, 'entity/task-editor-command')
})
test('new public or native entity detail must register, including named re-exports', () => {
  for (const file of ['components/account/widget.tsx', 'apps/mobile/features/example/editor.tsx']) {
    for (const source of ['export function OrderDetail() {}', 'export const InvoiceDetailPanel = () => null', "export { Editor as OrderDetail } from './editor'"]) {
      assert.equal(auditEntityDetail(file, source)[0].rule, 'entity/detail-source')
    }
  }
  assert.deepEqual(auditEntityDetail('components/mock.test.tsx', 'export function MockDetail() {}'), [])
  assert.deepEqual(auditEntityDetail('components/example.tsx', 'export type OrderDetail = object'), [])
})
test('a parallel task controller fails even when it is not exported', () => {
  assert.equal(auditEntityDetail('components/entries/board.tsx', 'function TaskDetailController() {}')[0].rule, 'entity/detail-source')
})
test('the manifest resolves actual value exports and catches an erased command', () => {
  const read = file => readFileSync(file, 'utf8')
  assert.deepEqual(verifyEntityContracts(read), [])
  const missing = verifyEntityContracts(file => file === 'app/actions/issues.ts' ? 'export type saveIssue = never' : read(file))
  assert.ok(missing.some(d => d.message.includes('saveIssue')))
})
