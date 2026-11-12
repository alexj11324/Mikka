import assert from 'node:assert/strict'
import test from 'node:test'
import { canAnswerCard, outgoingKey, personalMessage, sendFailureState, submissionBody, unsettled } from '../lib/outbox.ts'

test('an unconfirmed message keeps one UUID and immutable body through bubble and composer retries', () => {
  const key = outgoingKey()
  assert.match(key, /^[0-9a-f-]{36}$/)
  const image = { uri: 'file:///photo.jpg', dataUrl: 'data:image/jpeg;base64,/9j/' }
  const first = personalMessage(key, '请处理', [image], { botId: 'bot', chatKey: 'coordinator', context: 7 })
  const pending = [{ ...first, phase: 'failed' as const, error: 'unconfirmed' }]
  const original = submissionBody(pending[0])
  image.dataUrl = 'changed attachment'
  assert.equal(original.images?.[0].dataUrl, 'data:image/jpeg;base64,/9j/', 'attachment input cannot mutate a held identity')
  assert.equal(pending[0].phase, 'failed')
  assert.equal(pending[0].error, 'unconfirmed')
  const retry = unsettled(pending, '请处理', [{ ...image, dataUrl: original.images![0].dataUrl }], 'coordinator', 7)!
  assert.equal(retry.submissionId, key)
  assert.deepEqual(submissionBody(retry), original)
  assert.equal(unsettled(pending, 'edited', [], 'coordinator', 7), undefined)
  assert.equal(unsettled(pending, '请处理', retry.images, 'another chat', 7), undefined)
  assert.equal(unsettled(pending, '请处理', retry.images, 'coordinator', 8), undefined, 'an account/workspace change cannot reuse the previous context')
  assert.equal(unsettled([{ ...first, phase: 'accepted' }], '请处理', retry.images, 'coordinator', 7), undefined, 'a confirmed send may be intentionally sent again with a new identity')
})

test('transport failures stay unconfirmed while known validation/auth refusals are not sent', () => {
  for (const failure of [Error('network'), { status: 408 }, { status: 500 }, { status: 502 }, null]) assert.equal(sendFailureState(failure), 'unconfirmed')
  for (const status of [400, 401, 403, 404, 409, 413]) assert.equal(sendFailureState({ status }), 'failed')
  assert.equal(outgoingKey(() => 'native-uuid'), 'native-uuid', 'Expo supplies the native UUID implementation without a new native module')
})

test('only the originating choice can reopen an unsettled answer and transport keeps its immutable body', () => {
  const draft = [personalMessage('op1', 'Keep the original draft', [], { sourceCardId: 'card-a', chatKey: 'chat', context: 3, botId: null })]
  assert.equal(canAnswerCard([], 'card-a'), true)
  assert.equal(canAnswerCard(draft, 'card-a'), false)
  for (const state of ['failed', 'unconfirmed'] as const) {
    const saved = [{ ...draft[0], phase: 'failed' as const, error: state }]
    assert.equal(canAnswerCard(saved, 'card-a'), true)
    assert.equal(canAnswerCard(saved, 'card-b'), false)
    assert.equal(canAnswerCard([...saved, personalMessage('other', 'Another message', [], { botId: null, context: 3, chatKey: 'chat' })], 'card-a'), false)
    const same = unsettled(saved, 'Keep the original draft', [], 'chat', 3, 'card-a')!
    assert.equal(same.submissionId, 'op1')
    assert.equal(unsettled(saved, 'Keep the original draft', [], 'chat', 3), undefined)
    assert.equal(unsettled(saved, 'Keep the original draft', [], 'chat', 3, 'another-card'), undefined)
    assert.deepEqual(submissionBody(same), { text: 'Keep the original draft', botId: null, submissionId: 'op1' })
  }
})

test('personal delivery keeps acknowledged messages until an authorized read and replays only the original uncertain command', async () => {
  const { mock } = await import('node:test')
  const { Window } = await import('happy-dom')
  const browser = new Window({ url: 'https://fixture.example' })
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const React = await import('react')
  const { act, createElement } = React
  // Metro resolves the shared delivery hook to Expo's React. Reproduce its singleton in the Node renderer.
  const { createRequire } = await import('node:module')
  const sharedReact = createRequire(new URL('../../../lib/hooks/chat-delivery-state.ts', import.meta.url)).resolve('react')
  if (sharedReact !== createRequire(import.meta.url).resolve('react')) {
    mock.module(sharedReact, { defaultExport: React.default, namedExports: { useEffect: React.useEffect } })
  }
  const { createRoot } = await import('react-dom/client')
  const { createConversationJournal } = await import('../lib/conversation-journal.ts')
  const { apiCache } = await import('../lib/api-cache.ts')
  const storage = new Map<string, string>()
  const journal = createConversationJournal({
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value) },
  })
  journal.bind('owner', 'session')
  mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { conversationJournal: journal } })
  const { usePersonalDelivery } = await import('../features/chat/components/personal-delivery.ts')
  const requests: { id: string; text: string; resolve: () => void; reject: (error: Error) => void }[] = []
  const send = (text: string, id: string) => new Promise<void>((resolve, reject) => requests.push({ id, text, resolve, reject }))
  let reads = 0
  const reload = async () => { reads++; throw new Error('transcript unavailable') }
  let scope: string | null = 'owner-workspace-coordinator'
  let received = new Set<string>()
  let held!: ReturnType<typeof usePersonalDelivery>
  function Probe() { held = usePersonalDelivery(scope, received, send, reload); return null }
  let root = createRoot(document.body)
  const render = () => act(async () => { root.render(createElement(Probe)) })
  const separateScreen = async () => {
    await act(async () => { root.unmount() })
    apiCache.clear()
    root = createRoot(document.body)
    await render()
  }
  await render()
  try {
    const first = personalMessage('p1','first',[],{ context:apiCache.context(), chatKey:'coordinator', botId:null })
    let result!: Promise<boolean> | false
    await act(async () => { result = held.start(first); assert.equal(result, held.start(first)) })
    assert.equal(held.rows[0].phase,'sending')
    assert.equal(requests.length,1)
    assert.equal(journal.readPersonal(scope)[0].submissionId,'p1')
    await act(async () => { requests[0].resolve(); assert.equal(await result,true) })
    assert.equal(reads,1)
    assert.equal(held.rows[0].phase,'accepted')
    await separateScreen()
    assert.equal(held.rows[0].phase,'accepted')
    received = new Set(['p1'])
    await render()
    assert.deepEqual(held.rows,[])
    assert.deepEqual(journal.readPersonal(scope),[])
    const second = personalMessage('p2','same body',[],{ context:apiCache.context(), chatKey:'coordinator', botId:null })
    await act(async () => { result=held.start(second); requests[1].reject(new Error('lost response')); assert.equal(await result,false) })
    assert.equal(held.rows[0].phase,'failed')
    await separateScreen()
    const restored=held.rows[0]
    assert.equal(restored.submissionId,'p2')
    assert.equal(restored.text,'same body')
    scope=null
    await render()
    assert.equal(held.start(restored),false)
    assert.deepEqual(held.rows,[])
    scope='owner-workspace-coordinator'
    await render()
    await act(async () => { result=held.start(held.rows[0]); requests[2].resolve(); assert.equal(await result,true) })
    assert.deepEqual(requests.map(({id,text})=>[id,text]),[['p1','first'],['p2','same body'],['p2','same body']])
    received=new Set(['p2'])
    await render()
    assert.deepEqual(held.rows,[])
  } finally {
    await act(async () => { root.unmount() })
    await browser.happyDOM.close()
  }
})
