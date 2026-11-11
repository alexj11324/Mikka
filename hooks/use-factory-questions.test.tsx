import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { SWRConfig, type Cache } from 'swr'
import { Window } from 'happy-dom'

const question = { questionId: 'question-one', taskId: 'factory-one', runId: 'run-one', status: 'pending', type: 'decision', question: 'Which branch?', options: [{ label: 'Main', value: 'main' }], reference: { protocol: 'fixture', id: 'reference-one' } }
let failure: number | Error | null, pending: boolean, taskFailure: boolean
let afterAnswerFailure: boolean
const requests: { path: string; init?: RequestInit }[] = []
mock.module('@/app/actions/issues', { namedExports: { getIssue: async () => ({ issue: { identifier: 'MIK-1', title: 'Task' } }) } })
const browser = new Window({ url: 'https://fixture.example/' })
let container: HTMLDivElement, root: Root, cache: Cache
let createRoot: typeof import('react-dom/client')['createRoot']
let useFactoryQuestions: typeof import('./use-factory-questions')['useFactoryQuestions']
let state: ReturnType<typeof useFactoryQuestions>
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    requests.push({ path, init })
    if (init?.method === 'POST') { pending = false; if (afterAnswerFailure) failure = 503; return Response.json({ answered: true }) }
    if (path.endsWith('/api/factory/questions')) {
      if (failure instanceof Error) throw failure
      if (failure) return Response.json({ error: 'unavailable' }, { status: failure })
      return Response.json({ questions: pending ? [question] : [] })
    }
    if (path.endsWith('/api/factory/tasks/factory-one')) return Response.json(taskFailure ? { error: 'missing' } : { task: { issueId: 'issue-one' } }, { status: taskFailure ? 404 : 200 })
    throw new Error('Unexpected local fixture request')
  }) as typeof fetch
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useFactoryQuestions } = await import('./use-factory-questions'))
})
beforeEach(() => {
  failure = null; pending = true; taskFailure = false; afterAnswerFailure = false; requests.length = 0; cache = new Map()
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) })
function Probe({ version, enabled }: { version: string; enabled: boolean }) { state = useFactoryQuestions(version, enabled); return null }
async function render(version = 'one', enabled = true) {
  await act(async () => root.render(<SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}><Probe version={version} enabled={enabled} /></SWRConfig>))
  await settle()
}
for (const kind of ['http', 'network'] as const) {
  test(`a Factory question ${kind} failure is not a successful empty question list and can retry`, async () => {
    failure = kind === 'http' ? 503 : Error('offline')
    await render()
    assert.ok(state.error)
    if (kind === 'http') assert.equal(state.error.status, 503)
    failure = null
    await act(async () => { await state.reload() })
    assert.equal(state.error, null)
    assert.equal(state.questions[0].task, 'MIK-1 Task')
    assert.equal(state.questions[0].issueId, 'issue-one')
  })
}
test('a failed new version preserves previously read questions with an explicit error', async () => {
  await render()
  failure = 503
  await render('two')
  assert.equal(state.questions[0].questionId, 'question-one')
  assert.ok(state.error)
})
test('answering retains the existing reference, fresh answer id and refresh protocol', async () => {
  await render()
  await act(async () => { assert.equal(await state.answer(state.questions[0], 'Use main'), null) })
  const sent = requests.find(request => request.init?.method === 'POST')!
  assert.ok(sent.path.endsWith('/api/factory/questions/question-one'))
  const body = JSON.parse(String(sent.init?.body))
  assert.deepEqual(body.reference, question.reference)
  assert.equal(body.text, 'Use main')
  assert.match(body.answerId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(state.questions, [])
})
test('optional task metadata failure retains the pending question', async () => {
  taskFailure = true
  await render()
  assert.equal(state.questions[0].questionId, 'question-one')
  assert.equal(state.questions[0].issueId, null)
  assert.equal(state.error, null)
})
test('an accepted answer with a failed refresh exposes the read error without resending the answer', async () => {
  await render(); afterAnswerFailure = true
  await act(async () => { assert.equal(await state.answer(state.questions[0], 'Use main'), null) })
  assert.ok(state.error)
  failure = null
  await act(async () => { await state.reload() })
  assert.equal(state.error, null)
  assert.deepEqual(state.questions, [])
  assert.equal(requests.filter(request => request.init?.method === 'POST').length, 1)
})
test('a disabled question source reads nothing', async () => {
  await render('one', false)
  assert.deepEqual(requests, [])
  assert.deepEqual(state.questions, [])
  assert.equal(state.error, null)
})
