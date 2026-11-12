import assert from 'node:assert/strict'
import test from 'node:test'
import { bindWorkersAi, configureWorkersAi, workersAiRequest } from '../../../cloudflare/workers-ai/binding.mjs'

const url = 'https://workers-ai.internal/v1/chat/completions'
const model = '@cf/deepseek-ai/deepseek-v4.1-flash-1017'
const input = { model, messages: [{ role: 'user', content: 'fixture' }], max_tokens: 8 }
const capability = crypto.randomUUID() + crypto.randomUUID()
function request(body = input, target = url, auth = capability, type = 'application/json') {
  return new Request(target, { method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': type, cookie: 'private=fixture' }, body: JSON.stringify(body) })
}

test('an AI binding uses a per-host credential across restarts, without retaining the provider key', async () => {
  const state = new Map()
  const create = (state, account = 'a'.repeat(32)) => {
    const container = { envVars: { CLOUDFLARE_WORKERS_AI_TOKEN: 'fixture' } }
    configureWorkersAi(container, { storage: { kv: {get: k => state.get(k), put: (k, v) => state.set(k, v)} } }, account)
    return container.envVars
  }
  const first = create(state)
  assert.equal(first.CLOUDFLARE_WORKERS_AI_TOKEN, undefined)
  assert.equal(create(state).MIKKA_WORKERS_AI_CAPABILITY, first.MIKKA_WORKERS_AI_CAPABILITY)
  assert.notEqual(create(new Map()).MIKKA_WORKERS_AI_CAPABILITY, first.MIKKA_WORKERS_AI_CAPABILITY)
  assert.throws(() => create(state, 'unscoped'))
  const bound = []
  await bindWorkersAi({container: {interceptOutboundHttps: (...args) => bound.push(args)}, exports: {WorkersAiOutbound: ({ props }) => props}}, first)
  assert.deepEqual(bound, [['workers-ai.internal', {capability: first.MIKKA_WORKERS_AI_CAPABILITY}]])
})

test('approved tool JSON and SSE pass through with cancellation and original usage bytes', async () => {
  for (const stream of [false, true]) {
    const type = stream ? 'text/event-stream' : 'application/json'
    const bytes = stream ? 'data: {"choices":[],"usage":{"prompt_tokens":17}}\n\ndata: [DONE]\n\n' : '{"choices":[{"message":{"tool_calls":[]}}],"usage":{"prompt_tokens":17}}'
    const opts = { ...input, stream, tools: [{type:'function', function:{name:'fixture'}}] }
    const req = request(opts)
    const result = await workersAiRequest(req, { async run(id, params, init) {
      assert.equal(id, model)
      const {model: _, ...expected} = opts
      assert.deepEqual(params, expected)
      assert.equal(init.signal, req.signal)
      assert.equal(init.returnRawResponse, true)
      return new Response(bytes, { headers: { 'content-type': type, 'set-cookie': 'secret' } })
    } }, capability)
    assert.equal(result.status, 200)
    assert.deepEqual(Object.fromEntries(result.headers), {'cache-control':'no-store','content-type':type})
    assert.equal(await result.text(), bytes)
  }
})

test('scope, byte and output limits reject before any inference', async () => {
  const none = { run() { assert.fail('unexpected model invocation') } }
  for (const [r,status] of [
    [request(input, url + '?x=1'),404], [request(input, 'https://elsewhere.invalid/'),404],
    [new Request(url),404], [request(input, url, 'another'),403], [request(input,url,capability,'text/plain'),415],
    [request({...input,model:'unlicensed'}),400], [request({...input,max_tokens:4097}),400],
    [request({...input,n:2}),400], [request({...input,provider:'gateway'}),400],
    [request({...input,messages:[]}),400], [request({...input,stream:'yes'}),400],
  ]) assert.equal((await workersAiRequest(r, none, capability)).status, status)
  const large = request(); large.headers.set('content-length', String(16 * 1024 * 1024 + 1))
  assert.equal((await workersAiRequest(large,none,capability)).status,413)
  assert.equal((await workersAiRequest(request(),undefined,capability)).status,503)
})

test('provider faults have bounded statuses and no upstream details', async () => {
  for (const [run,status] of [[() => new Response('sensitive',{status:429}),429],
    [() => new Response('sensitive',{status:403}),502],[() => new Response('<html>'),502],
    [() => {throw new Error('sensitive')},502]]) {
    const result = await workersAiRequest(request(),{run},capability)
    assert.equal(result.status,status)
    assert.equal(await result.text(),'')
  }
})

const tokenUsage = { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15,
  prompt_tokens_details: { cached_tokens: 2 }, neurons: 0.125 }
const lastChoice = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
const summary = { response: 'Already streamed café', usage: tokenUsage }
const event = (value, ending = '\n') => 'data: ' + JSON.stringify(value) + ending + ending
function fragmented(text, width = 5) {
  const bytes = new TextEncoder().encode(text)
  let index = 0
  return new ReadableStream({ pull(controller) {
    if (index === bytes.length) { controller.close(); return }
    const end = Math.min(index + width, bytes.length)
    controller.enqueue(bytes.subarray(index, end))
    index = end
  } })
}
async function adapted(body) {
  return workersAiRequest(request({ ...input, stream: true }), { async run() {
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  } }, capability)
}

test('native Workers AI summary becomes an empty choices usage frame after a real finish', async () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    const original = ': heartbeat' + ending + ending +
      event({ choices: [{ index: 0, delta: { role: 'assistant', content: summary.response }, finish_reason: null }] }, ending) +
      event(lastChoice, ending) + event({ choices: [], usage: tokenUsage }, ending)
    const done = 'data: [DONE]' + ending + ending
    const body = await adapted(fragmented(original + event(summary, ending) + done, 1))
    assert.equal(await body.text(), original + event({ choices: [], usage: tokenUsage }, ending) + done)
  }
})

test('early summaries, errors, malformed frames and unrelated provider extensions pass through', async () => {
  const bad = [event(summary), event(lastChoice), event({ ...summary, error: { message: 'provider error' } }),
    event({ ...summary, usage: { prompt_tokens: 5 } }), event({ response: 'only' }),
    'data: {broken\n\n', ': comment\n\n', event({ choices: [], usage: null }),
    'data: [DONE]\n\n', event(summary)].join('')
  assert.equal(await (await adapted(fragmented(bad))).text(), bad)
})

test('oversize ordinary data passes through and downstream cancellation releases the native reader', async () => {
  const huge = event({ choices: [{ delta: { content: 'a'.repeat(1024 * 1024 + 200) } }] })
  const input = huge + event(lastChoice) + event(summary)
  assert.equal(await (await adapted(fragmented(input, 7777))).text(), huge + event(lastChoice) + event({ choices: [], usage: tokenUsage }))
  let stopped
  const cancelled = new Promise(done => { stopped = done })
  const inputStream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(event({ choices: [{ delta: { content: 'first' } }] }))) },
    cancel(reason) { stopped(reason) },
  })
  const reader = (await adapted(inputStream)).body.getReader()
  assert.ok((await reader.read()).value.byteLength)
  await reader.cancel('fixture stop')
  assert.equal(await cancelled, 'fixture stop')
})
