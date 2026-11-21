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

test('an unregistered mobile entity route and a false Task re-export cannot bypass registration', () => {
  const task = 'apps/mobile/app/task/[id]/index.tsx'
  assert.deepEqual(auditEntityDetail(task, readFileSync(task, 'utf8')), [])
  assert.equal(auditEntityDetail('apps/mobile/app/invoice/[slug].tsx', 'export default function Screen() {}')[0].rule, 'entity/native-detail-route')
  assert.equal(auditEntityDetail(task, "export { TaskScreen as default } from './copy'")[0].rule, 'entity/native-detail-route')
  assert.equal(auditEntityDetail('hooks/use-detail.ts', 'export function useTaskPanelController() {}')[0].rule, 'entity/detail-source')
  assert.equal(auditEntityDetail('lib/task-flow.ts', 'function TaskDetailController() {}')[0].rule, 'entity/detail-source')
})

test('Inbox, Factory question and composer have one registered web hook owner', () => {
  const read = file => readFileSync(file, 'utf8')
  assert.deepEqual(verifyEntityContracts(read), [])
  for (const [file, source] of [
    ['components/workspace/inbox-counter.tsx', 'function useInboxCount() {}'],
    ['hooks/use-other-questions.ts', 'export function useFactoryQuestions() {}'],
    ['hooks/use-other-questions.ts', 'export function factoryQuestionsVersion() {}'],
    ['components/slots/composer-clone.tsx', "export { useChatComposer } from '@/hooks/use-chat-composer'"],
  ]) {
    const diagnostics = auditEntityDetail(file, source)
    assert.equal(diagnostics[0]?.rule, 'entity/shared-hook-owner', file)
  }
  assert.deepEqual(auditEntityDetail('hooks/use-inbox-count.ts', 'export function useInboxCount() {}'), [])
  // Native screens may have platform-specific state adapters, not a second web owner.
  assert.deepEqual(auditEntityDetail('apps/mobile/features/inbox/use-count.ts', 'export function useInboxCount() {}'), [])
  for (const [file, name] of [
    ['hooks/use-inbox-count.ts', 'useInboxCount'],
    ['hooks/use-factory-questions.ts', 'useFactoryQuestions'],
    ['hooks/use-chat-composer.ts', 'useChatComposer'],
  ]) {
    const missing = verifyEntityContracts(path => path === file ? `export type ${name} = never` : read(path))
    assert.ok(missing.some(d => d.file === file && d.message.includes(name)), file)
  }
})
