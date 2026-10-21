import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAgentResponse } from '../lib/agent-fetch.ts'

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
