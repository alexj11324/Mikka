import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAgentResponse, validateAgentStream } from '../lib/agent-fetch.ts'

async function checkStream(parts) {
  return Array.fromAsync(ReadableStream.from(parts).pipeThrough(validateAgentStream()))
}

test('正常结束保留全部正文，不人为截断长回复', async () => {
  const parts = [{ type: 'text-delta', id: 'answer', delta: '详细正文'.repeat(10000) }, { type: 'finish', finishReason: 'stop' }]
  assert.deepEqual(await checkStream(parts), parts)
})

test('思考耗尽预算和空回复不会显示为成功', async () => {
  for (const finishReason of ['length', 'stop']) {
    const parts = await checkStream([{ type: 'text-delta', id: 'answer', delta: '  ' }, { type: 'finish', finishReason }])
    assert.equal(parts.filter(part => part.type === 'error').length, 1)
    assert.match(parts.find(part => part.type === 'error').errorText, finishReason === 'length' ? /输出上限/ : /未返回正文/)
  }
})

test('流提前断开保留正文并通知重试，已有错误不重复追加', async () => {
  const partial = { type: 'text-delta', id: 'answer', delta: '已生成的正文' }
  const interrupted = await checkStream([partial])
  assert.deepEqual(interrupted[0], partial)
  assert.match(interrupted[1].errorText, /连接提前结束/)
  const error = { type: 'error', errorText: '上游限流' }
  assert.deepEqual(await checkStream([error, { type: 'finish', finishReason: 'error' }]), [error, { type: 'finish', finishReason: 'error' }])
})

test('主动停止不生成空回复或连接中断错误', async () => {
  const parts = [{ type: 'abort' }]
  assert.deepEqual(await checkStream(parts), parts)
})

test('请求头尚未返回时，即使预览传输忽略取消，也能结束等待', async t => {
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}))
  const controller = new AbortController()
  const pending = fetchAgentResponse('https://example.test/agent', { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('响应头已返回时，停止会中断流读取并取消上游', async t => {
  let cancelled = false
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), {
    headers: { 'Content-Type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  }))
  const controller = new AbortController()
  const response = await fetchAgentResponse('https://example.test/agent', { signal: controller.signal })
  assert.equal(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1')
  const reader = response.body.getReader()
  const pending = reader.read()
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(cancelled, true)
})

test('正常 SSE 响应保持内容、状态和响应头', async t => {
  const body = 'data: [DONE]\n\n'
  t.mock.method(globalThis, 'fetch', async () => new Response(body, {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  }))
  const response = await fetchAgentResponse('https://example.test/agent', { signal: new AbortController().signal })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), body)
})
