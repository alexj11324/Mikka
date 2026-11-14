import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, createElement } from 'react'
import { Window } from 'happy-dom'
import { mobileMessages } from '../lib/messages.ts'
import { sameConversationCommand, submitConversation, type ConversationCommand } from '../lib/conversation-submission.ts'
import { threadModelKey, type ThreadModelChoice } from '../../../lib/thread-model-choice.ts'

const choice: ThreadModelChoice = { model: 'gpt-5.1', source: { kind: 'subscription', connectionId: '50000000-0000-4000-8000-000000000005' } }
const option = { id: threadModelKey(choice), modelId: choice.model }
const taskId = '10000000-0000-4000-8000-000000000001'
const runId = '20000000-0000-4000-8000-000000000002'
const requests: unknown[] = []
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
mock.module('react-native', { namedExports: { View: 'div', Pressable: ({ onPress, children }: any) => createElement('button', { onClick: onPress }, children) } })
stub('components/Text.tsx', { Text: 'span' })
stub('components/ModelMenu.tsx', { ModelMenu: ({ model }: any) => createElement('button', { id: 'choose', onClick: () => model.choose(option.id) }, option.modelId) })
stub('lib/api-cache.ts', { apiCache: { context: () => 'test' } })
stub('lib/home.tsx', { useHome: () => ({ data: { workspace: { id: 'workspace' } } }) })
stub('lib/useApi.ts', { useApi: (key: string | null) => ({ data: key ? { current: {}, groups: [{ kind: 'subscription', options: [option] }] } : null }) })
stub('lib/api.ts', { api: async (_path: string, init: { body: unknown }) => {
  requests.push(init.body)
  return { ok: true, version: 1, result: [{ kind: 'task', id: taskId, title: 'Saved task' }] }
} })
stub('features/chat/components/chat-composer.tsx', { Composer: (props: any) => createElement('div', null, props.notice, props.accessory,
  createElement('input', { value: props.value, onInput: (e: any) => { props.onChangeText(e.target.value); props.onCaretChange(e.target.selectionEnd) }, readOnly: true }),
  createElement('button', { id: 'send', onClick: () => props.onSend(props.value) }, 'send')) })
const { ThreadComposer } = await import('../features/chat/components/thread-composer.tsx')

test('the native composer selects a funded continuation, inserts the authorized mention at its caret, and keeps the served model separate', async () => {
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), sends: unknown[] = []
  const detail = { liveRunId: runId, issueId: taskId, active: false, thread: { harness: 'codex' }, composerModel: { selectedModel: 'requested-model', servedModel: 'served-model' } }
  const render = (data: typeof detail | Omit<typeof detail, 'issueId'>) => root.render(createElement(ThreadComposer, { detail: data as never, runId, placeholder: '', onSend: (...args) => { sends.push(args); return true } }))
  try {
    await act(async () => render(detail))
    assert.ok(host.textContent?.includes('served-model'))
    assert.ok(host.textContent?.includes(mobileMessages.IssueThreads.composerModelRequested.replace('{model}', 'requested-model')))
    await act(async () => host.querySelector<HTMLButtonElement>('#choose')!.click())
    const input = host.querySelector('input')!
    await act(async () => { input.value = 'See @task:sa please'; input.setSelectionRange(12,12); input.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve,220)) })
    assert.deepEqual(requests, [{ version: 1, action: 'task-runs.findThreadReferences', args: ['workspace','sa','task'] }])
    const item = Array.from(host.querySelectorAll('button')).find(node => node.textContent?.includes('Saved task')); assert.ok(item)
    await act(async () => item.click())
    await act(async () => host.querySelector<HTMLButtonElement>('#send')!.click())
    assert.deepEqual(sends, [[`See [[issue:${taskId}]]  please`, choice]])
    await act(async () => render({ ...detail, active: true }))
    assert.equal(host.querySelector('#choose'), null)
    const { issueId: _issueId, ...standalone } = detail
    await act(async () => render(standalone))
    assert.equal(host.querySelector('#choose'), null)
    assert.ok(host.textContent?.includes('served-model'))
  } finally { await act(async () => root.unmount()); host.remove(); await browser.happyDOM.close() }
})

test('native journal replay sends the initial model and funding source with the same command identity', async () => {
  const target = { kind: 'thread' as const, id: runId, issueId: taskId, modelChoice: choice }
  const command: ConversationCommand = { id: 'repeat', target, text: 'go', at: 1, expectedOwnerId:'owner', expectedWorkspaceId:'workspace', mentions:[] }
  assert.equal(sameConversationCommand(command, target, 'go', []), true)
  assert.equal(sameConversationCommand(command, { ...target, modelChoice: undefined }, 'go', []), false)
  assert.equal(sameConversationCommand(command, { ...target, modelChoice: { ...choice, source: {kind:'api_key',keyId:taskId} } }, 'go', []), false)
  await submitConversation(command, async (path, input) => { assert.equal(path,'/api/rpc'); assert.deepEqual(input.body, { version:1,action:'agents.sendIssueThreadReply',args:[{ issueId:taskId,runId,modelChoice:choice,text:'go',requestId:'repeat',expectedOwnerId:'owner',expectedWorkspaceId:'workspace'}] }); return { ok:true, version:1, result:{sent:true,runId} } }, 'stored')
})
