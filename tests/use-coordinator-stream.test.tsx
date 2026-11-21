import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import { turn } from 'eve/events'
import { useCoordinatorAgent } from '../components/coordinator/use-coordinator-agent'

const browser = new Window({ url: 'https://mikka.example/' })
let createRoot: typeof import('react-dom/client')['createRoot']
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, location: browser.location, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
})

const headers = { 'content-type': 'application/x-ndjson', 'x-eve-stream-format': 'ndjson', 'x-eve-stream-version': '27', 'x-eve-stream-tail-index': '0' }
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 50 && !condition(); attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.ok(condition(), 'expected native client operation')
}

test('eve bootstraps the mapped session and owns replay, stop, and cancellation on Bot switch', async () => {
  const original = globalThis.fetch
  const requests: { method: string; url: string; body?: Record<string, unknown> }[] = []
  const streams: { cancelled: boolean; controller: ReadableStreamDefaultController<Uint8Array> }[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET'
    requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (method === 'POST') return Response.json({ ok: true, sessionId: 'wrun_fixture', ...(url.includes('/cancel') ? { deliveryId: 'cancel_fixture' } : {}) })
    const entry = { cancelled: false } as typeof streams[number]
    const body = new ReadableStream<Uint8Array>({ start(controller) { entry.controller = controller }, cancel() { entry.cancelled = true } })
    streams.push(entry)
    return new Response(body, { headers })
  }
  const container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container)
  const root = createRoot(container)
  let output!: ReturnType<typeof useCoordinatorAgent>
  let botId = 'bot-a'
  function Probe() { output = useCoordinatorAgent({ botId, enabled: true, revalidate: async () => undefined }); return null }
  const render = () => act(async () => { root.render(<Probe key={botId} />) })
  const line = async (index: number, value: unknown) => act(async () => {
    streams[index].controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n'))
  })
  try {
    await render()
    await until(() => streams.length === 1)
    assert.match(requests[0].url, /botId=bot-a/)
    assert.match(requests[0].url, /\/eve\/v1\/session/)
    await line(0, { at: '2026-11-11T00:00:00.000Z', facts: [
      { type: 'session.started', data: {} },
      { type: 'delivery.admitted', data: { deliveryId: 'd1', source: { channel: 'eve' } } },
      { type: 'turn.started', data: { turnId: 't1', cause: { deliveryId: 'd1' }, follows: null } },
      { type: 'delivery.consumed', data: { deliveryId: 'd1', turnId: 't1', parts: [{ kind: 'text', text: 'Hello' }] } },
      { type: 'model.requested', scope: { turnId: 't1' }, data: { runId: 'r1', owner: { turnId: 't1' } } },
      { type: 'model.started', scope: { turnId: 't1', runId: 'r1' }, data: { runId: 'r1', modelId: 'fixture', attempt: 0 } },
    ] })
    await line(0, { progress: { type: 'content.delta', scope: { turnId: 't1', runId: 'r1' }, data: { partId: 'p1', kind: 'text', delta: 'First words' } } })
    await until(() => output.replies[0]?.text === 'First words')
    assert.equal(output.status, 'busy')
    const before = streams.length
    await act(async () => { output.reconnect() })
    assert.equal(streams.length, before, 'push catch-up does not create a second active reader')
    await act(async () => { await output.cancel() })
    const cancellation = requests.find(request => request.url.includes('/cancel'))
    assert.equal(cancellation?.body?.turnId, 't1', 'eve fences stop to the observed turn')
    await line(0, { at: '2026-11-11T00:00:01.000Z', facts: [
      { type: 'delivery.admitted', data: { deliveryId: 'cancel_fixture', source: { control: 'cancel' } } },
      { type: 'model.settled', scope: { turnId: 't1', runId: 'r1' }, data: { runId: 'r1', outcome: 'completed' } },
      { type: 'turn.settled', scope: { turnId: 't1' }, data: { turnId: 't1', outcome: 'cancelled' } },
      { type: 'delivery.settled', data: { deliveryId: 'd1', outcome: 'handled', turnId: 't1' } },
      { type: 'delivery.settled', data: { deliveryId: 'cancel_fixture', outcome: 'applied', turnId: 't1' } },
    ] })
    await until(() => output.status === 'idle')
    assert.equal(streams[0].cancelled, true)
    const idleRequests = requests.length
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    assert.equal(requests.length, idleRequests, 'idle does not schedule a stream or history poll')
    botId = 'bot-b'
    await render()
    await until(() => streams.length >= 2)
    assert.equal(streams[0].cancelled, true)
    assert.deepEqual(output.replies, [], 'another Bot never inherits the previous store')
    assert.ok(requests.some(request => /botId=bot-b/.test(request.url)))
  } finally {
    await act(async () => { root.unmount() })
    globalThis.fetch = original
    container.remove()
  }
})

test('a first-turn no-model refusal is not a thread load error, but transport failures remain visible', async () => {
  const original = globalThis.fetch
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let failRead = false
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') return Response.json({ ok: true, sessionId: 'wrun_first_send' })
    if (failRead) return Response.json({ error: 'unavailable' }, { status: 503 })
    return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value } }), { headers })
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let output!: ReturnType<typeof useCoordinatorAgent>
  function Probe() {
    output = useCoordinatorAgent({ botId: null, enabled: true, revalidate: async () => undefined })
    return <>{output.error ? 'Could not load the conversation.' : null}</>
  }
  try {
    await act(async () => { root.render(<Probe />) })
    await until(() => !!controller)
    assert.equal(output.error, undefined, 'an empty chat loads normally')
    await act(async () => {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ at: '2026-11-11T00:00:00.000Z', facts: [
        { type: 'session.started', data: {} },
        { type: 'turn.started', data: { turnId: 'first', cause: { deliveryId: 'd1' }, follows: null } },
        { type: 'turn.settled', data: { turnId: 'first', outcome: 'failed', error: { code: 'HOOK_FAILED', message: 'executionModelUnknown' } } },
      ] }) + '\n'))
    })
    await until(() => turn(output.view, 'first')?.status === 'settled')
    assert.equal(turn(output.view, 'first')?.outcome, 'failed', 'the refusal remains in native history')
    assert.equal(container.textContent, '', 'a settled refusal must not show the load banner')
    assert.equal(output.error, undefined)
    failRead = true
    await act(async () => { await output.resume().catch(() => undefined) })
    await until(() => !!output.error)
    assert.match(container.textContent ?? '', /Could not load the conversation/)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    globalThis.fetch = original
  }
})
