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
const runAndChat = [
  { kind: 'thread', id: runId, title: 'Execution run' },
  { kind: 'thread', conversationKind: 'chat', id: runId, title: 'Standalone conversation' },
]
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
mock.module('react-native', { namedExports: { View: 'div', Pressable: ({ onPress, children }: any) => createElement('button', { onClick: onPress }, children) } })
stub('components/Text.tsx', { Text: 'span' })
const botWrites: [string, string][] = []
stub('components/ModelNotice.tsx', { ModelNotice: () => null })
stub('lib/model-menu.ts', { useModelMenu: (botId: string) => ({ choose: (choiceId: string) => botWrites.push([botId, choiceId]) }) })
stub('components/ModelMenu.tsx', { ModelMenu: ({ model }: any) => createElement('button', { id: 'choose', onClick: () => model.choose(option.id) }, option.modelId) })
stub('lib/api-cache.ts', { apiCache: { context: () => 'test' } })
stub('lib/home.tsx', { useHome: () => ({ data: { workspace: { id: 'workspace' } } }) })
stub('lib/useApi.ts', { useApi: (key: string | null) => ({ data: key ? { current: {}, groups: [{ kind: 'subscription', options: [option] }] } : null }) })
stub('lib/api.ts', { api: async (_path: string, init: { body: unknown }) => {
  requests.push(init.body)
  return { ok: true, version: 1, result: (init.body as {args?: unknown[]}).args?.[2] === 'thread' ? runAndChat : [{ kind: 'task', id: taskId, title: 'Saved task' }] }
} })
stub('features/chat/components/chat-composer.tsx', { Composer: (props: any) => createElement('div', null, props.notice, props.accessory,
  createElement('input', { value: props.value, onInput: (e: any) => { props.onChangeText(e.target.value); props.onCaretChange(e.target.selectionEnd) }, readOnly: true }),
  createElement('button', { id: 'send', onClick: () => props.onSend(props.value) }, 'send')) })
const { ThreadComposer, NamedBotModel } = await import('../features/chat/components/thread-composer.tsx')

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
    // A standalone conversation has no authorized repository binding. A source
    // mention stays literal, and never enters the task/PR directory endpoint.
    for (const value of ['@file:src/private.ts', '@folder:src/private']) {
      const input = host.querySelector('input')!
      const before = requests.length
      await act(async () => { input.value = value; input.selectionEnd = value.length; input.dispatchEvent(new browser.Event('input', { bubbles: true }) as never) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
      assert.ok(host.textContent?.includes(mobileMessages.ThreadReferences.sourceUnavailable))
      assert.equal(requests.length, before)
      assert.equal(input.value, value)
      assert.ok(!host.textContent?.includes('Saved task'))
    }
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

test('a native reference menu with an authorized standalone Chat and Run sharing a UUID selects either independently', async t => {
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.body)
  const errors = t.mock.method(console, 'error', () => {})
  try {
    const detail = { liveRunId: runId, issueId: taskId, active: true, thread: { harness: 'codex' } }
    await act(async () => root.render(createElement(ThreadComposer, { detail: detail as never, runId, placeholder: '', onSend: () => true })))
    const input = document.querySelector('input')!
    for (const [title, kind] of [['Standalone conversation', 'chat'], ['Execution run', 'run']]) {
      await act(async () => {
        input.value = '@thread:shared'
        input.setSelectionRange(input.value.length, input.value.length)
        input.dispatchEvent(new browser.Event('input', { bubbles: true }) as never)
      })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 230)) })
      const buttons = Array.from(document.querySelectorAll('button'))
      assert.ok(buttons.some(node => node.textContent?.includes('Standalone conversation')))
      assert.ok(buttons.some(node => node.textContent?.includes('Execution run')))
      await act(async () => buttons.find(node => node.textContent?.includes(title))!.click())
      assert.equal(input.value, `[[${kind}:${runId}]] `)
    }
    assert.equal(errors.mock.calls.filter(call => String(call.arguments[0]).includes('same key')).length, 0)
  } finally { await act(async () => root.unmount()); await browser.happyDOM.close() }
})

test('the named chat composer keeps the group draft and inserts a canonical Task only while the authorized workspace is available', async () => {
  const { ReferenceComposer } = await import('../features/chat/components/thread-composer.tsx')
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const { useState } = await import('react')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const sent: string[] = []
  function Group({ workspaceId }: { workspaceId?: string }) {
    const [value, setValue] = useState('')
    return createElement(ReferenceComposer, {
      value, workspaceId, onChangeText: setValue, placeholder: 'Group',
      attachmentScope: { kind: 'group', id: runId },
      onSend: text => { sent.push(text); return true },
    })
  }
  try {
    await act(async () => root.render(createElement(Group, { workspaceId: 'workspace' })))
    const input = host.querySelector('input')!
    const enter = async (text: string) => {
      await act(async () => {
        input.value = text
        input.setSelectionRange(text.length, text.length)
        input.dispatchEvent(new browser.Event('input', { bubbles: true }) as never)
      })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 230)) })
    }
    await enter('@Bot @task:sa')
    const task = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Saved task'))
    assert.ok(task)
    await act(async () => task.click())
    assert.equal(input.value, `@Bot [[issue:${taskId}]] `)
    await act(async () => host.querySelector<HTMLButtonElement>('#send')!.click())
    assert.deepEqual(sent, [input.value])
    await enter('@task:sa')
    assert.ok(host.textContent?.includes('Saved task'))
    await act(async () => root.render(createElement(Group, {})))
    assert.equal(host.textContent?.includes('Saved task'), false)
    assert.equal(host.querySelector('#choose'), null)
  } finally { await act(async () => root.unmount()); await browser.happyDOM.close() }
})

test('a named conversation with one owned Bot opens that Bot’s existing native model control and writes to that Bot only', async () => {
  const { namedConversationModelBot } = await import('../../../lib/named-conversation-model.ts')
  const bot = { id: 'first', name: 'First Bot', memberType: 'bot' as const }
  const other = { id: 'second', name: 'Second Bot', memberType: 'bot' as const }
  const agent = { id: 'worker', name: 'Agent', memberType: 'agent' as const }
  const person = { id: 'owner', name: 'Owner', memberType: 'user' as const }
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.body)
  try {
    const id = namedConversationModelBot('workspace', [person, bot], [bot])
    assert.equal(id, bot.id)
    await act(async () => root.render(createElement(NamedBotModel, { botId: id, running: true })))
    const choose = document.getElementById('choose')
    assert.ok(choose)
    await act(async () => choose.click())
    assert.deepEqual(botWrites, [[bot.id, option.id]])
    assert.equal(namedConversationModelBot('workspace', [bot, other], [bot, other]), undefined)
    const named = [bot, other, agent]
    assert.equal(namedConversationModelBot('workspace', named, [bot, other], '@Second Bot reply'), other.id)
    assert.equal(namedConversationModelBot('workspace', named, [bot, other], '@First Bot and @Second Bot'), undefined)
    assert.equal(namedConversationModelBot('workspace', named, [bot, other], '@Agent'), undefined)
    assert.equal(namedConversationModelBot('workspace', named, [bot], '@Second Bot'), undefined)
    assert.equal(namedConversationModelBot('workspace', [bot, agent], [bot]), undefined)
    assert.equal(namedConversationModelBot('workspace', [bot], [other]), undefined)
    assert.equal(namedConversationModelBot(undefined, [bot], [bot]), undefined)
  } finally { await act(async () => root.unmount()); botWrites.length = 0; await browser.happyDOM.abort() }
})
