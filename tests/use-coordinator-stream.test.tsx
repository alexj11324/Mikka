import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import { useCoordinatorStream } from '../components/coordinator/use-coordinator-stream'
import type { CoordinatorStreamEvent } from '@/lib/coordinator/stream'

const browser = new Window({ url: 'https://mikka.example/' })
let createRoot: typeof import('react-dom/client')['createRoot']
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
})

test('hook keeps one reader, rebuilds reconnects, reconciles history, and cancels on bot switch', async () => {
  const originalFetch = globalThis.fetch
  const streams: { controller: ReadableStreamDefaultController<Uint8Array>; cancelled: boolean; url: string; signal: AbortSignal }[] = []
  globalThis.fetch = async (input, options) => {
    const stream = { cancelled: false, url: String(input), signal: options!.signal as AbortSignal } as typeof streams[number]
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream.controller = controller }, cancel() { stream.cancelled = true } })
    streams.push(stream)
    return new Response(body)
  }
  const container = browser.document.createElement('div') as unknown as HTMLElement
  document.body.append(container)
  const root = createRoot(container)
  let output: ReturnType<typeof useCoordinatorStream>
  let props: Parameters<typeof useCoordinatorStream>[0] = { botId: null, runId: 'run', cursor: 0, revalidate: async () => { output.reconnect() } }
  function Probe() {
    output = useCoordinatorStream(props)
    return null
  }
  const render = () => act(async () => { root.render(<Probe />) })
  const send = (index: number, ...events: CoordinatorStreamEvent[]) => act(async () => {
    streams[index].controller.enqueue(new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n'))
  })
  try {
    await render()
    assert.equal(streams.length, 1)
    assert.match(streams[0].url, /runId=run/)
    await send(0, { type: 'start', id: 'run:0' }, { type: 'text', id: 'run:0', delta: 'first' })
    await act(async () => { output.reconnect() })
    await render()
    assert.equal(streams.length, 1, 'history polling does not interrupt an active reader')
    assert.equal(output.replies.map(reply => reply.text).join(''), 'first')
    props = { ...props, persistedStreamIds: ['run:0'] }
    await render()
    assert.deepEqual(output.replies, [], 'saved history suppresses the partial before its committed marker')
    assert.equal(streams.length, 1, 'history deduplication keeps the reader active')
    props = { ...props, persistedStreamIds: [] }
    await render()
    await act(async () => { streams[0].controller.close() })
    assert.equal(output.replies.map(reply => reply.text).join(''), 'first', 'a disconnected active run keeps its partial reply until replay')
    assert.equal(output.replies[0].committedThrough, undefined, 'disconnect does not mark partial text complete')
    assert.equal(output.error, true)
    assert.equal(streams.length, 1, 'the final revalidation does not immediately loop into reconnect')
    await act(async () => { output.reconnect() })
    assert.equal(streams.length, 2, 'the next successful history poll reconnects')
    await send(1, { type: 'start', id: 'run:0' }, { type: 'text', id: 'run:0', delta: 'first' }, { type: 'committed', id: 'run:0', through: 4, quiet: false }, { type: 'start', id: 'run:1' }, { type: 'text', id: 'run:1', delta: 'second' })
    assert.equal(output.replies.map(reply => reply.text).join(''), 'firstsecond', 'replay replaces the original text')
    props = { ...props, cursor: 4 }
    await render()
    assert.equal(output.replies.map(reply => reply.text).join(''), 'second')
    await send(1, { type: 'committed', id: 'run:1', through: 8, quiet: false })
    props = { ...props, runId: undefined }
    await render()
    assert.equal(streams[1].signal.aborted, true)
    assert.equal(streams[1].cancelled, true)
    assert.equal(output.replies.map(reply => reply.text).join(''), 'second', 'completed text survives a cleared lease until stored history arrives')
    props = { ...props, cursor: 8 }
    await render()
    assert.equal(output.replies.map(reply => reply.text).join(''), '')
    props = { ...props, runId: 'next' }
    await render()
    await send(2, { type: 'start', id: 'next:0' }, { type: 'text', id: 'next:0', delta: 'old bot' })
    props = { ...props, botId: 'other', runId: 'other-run' }
    await render()
    assert.equal(output.replies.map(reply => reply.text).join(''), '')
    assert.equal(streams[2].signal.aborted, true)
    assert.equal(streams[2].cancelled, true)
    assert.match(streams[3].url, /botId=other/)
  } finally {
    await act(async () => { root.unmount() })
    globalThis.fetch = originalFetch
    container.remove()
  }
  assert.equal(streams.at(-1)?.cancelled, true)
})
