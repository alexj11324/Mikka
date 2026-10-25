import { test } from 'node:test'
import assert from 'node:assert/strict'
import { persistAgentStream } from '../lib/agent-history.ts'

function source(parts) {
  return new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } })
}

async function collect(stream) {
  const parts = []
  for await (const part of stream) parts.push(part)
  return parts
}

const text = { type: 'text-delta', id: 'reply', delta: '测试回复' }

test('完成前保存完整回复，不保存推理片段', async () => {
  const saves = []
  const parts = [text, { type: 'reasoning-delta', id: 'reasoning', delta: '私有推理' }, { type: 'finish' }]
  const returned = await collect(persistAgentStream(source(parts), async checkpoint => { saves.push(checkpoint) }))
  assert.deepEqual(returned, parts)
  assert.deepEqual(saves, [{ completion: '测试回复', status: 'complete', error: null }])
})

test('失败回复保留正文和错误，不误标为完成', async () => {
  const saves = []
  await collect(persistAgentStream(source([text, { type: 'error', errorText: '输出被截断' }, { type: 'finish' }]), async checkpoint => { saves.push(checkpoint) }))
  assert.deepEqual(saves, [{ completion: '测试回复', status: 'failed', error: '输出被截断' }])
})

test('断流保存为失败，不静默当作成功', async () => {
  const saves = []
  await collect(persistAgentStream(source([text]), async checkpoint => { saves.push(checkpoint) }))
  assert.equal(saves[0].status, 'failed')
  assert.equal(saves[0].completion, '测试回复')
})

test('取消请求保存已生成片段且取消上游', async () => {
  let cancelled = false
  const upstream = new ReadableStream({ start(controller) { controller.enqueue(text) }, cancel() { cancelled = true } })
  const saves = []
  const reader = persistAgentStream(upstream, async checkpoint => { saves.push(checkpoint) }).getReader()
  await reader.read()
  await reader.cancel()
  assert.equal(cancelled, true)
  assert.deepEqual(saves, [{ completion: '测试回复', status: 'stopped', error: null }])
})

test('数据库检查点缓慢时正文继续返回，完成前仍等待保存', async t => {
  let now = 0
  t.mock.method(Date, 'now', () => now)
  let release
  const pending = new Promise(resolve => { release = resolve })
  const saves = []
  const reader = persistAgentStream(source([text, { ...text, delta: '第二段' }, { type: 'finish' }]), async checkpoint => {
    saves.push(checkpoint)
    if (checkpoint.status === 'pending') await pending
  }).getReader()
  now = 4000
  try {
    assert.deepEqual((await reader.read()).value, text)
    assert.equal((await reader.read()).value.delta, '第二段')
    const finished = reader.read()
    assert.equal(saves.some(value => value.status === 'complete'), false)
    release()
    assert.equal((await finished).value.type, 'finish')
    assert.equal((await reader.read()).done, true)
    assert.equal(saves.at(-1).completion, '测试回复第二段')
    assert.equal(saves.at(-1).status, 'complete')
  } finally {
    release()
    await reader.cancel()
  }
})

test('保存失败必须向客户端报告错误', async () => {
  const parts = await collect(persistAgentStream(source([text, { type: 'finish' }]), async () => { throw new Error('database unavailable') }))
  assert.equal(parts.at(-1).type, 'error')
  assert.match(parts.at(-1).errorText, /保存连接中断/)
  assert.equal(parts.some(part => part.type === 'finish'), false)
})

test('瞬时状态 chunk 只下发给前端，不写入历史', async () => {
  const saves = []
  const status = { type: 'data-agent-status', data: { phase: 'thinking', step: 0 }, transient: true }
  const parts = [status, { type: 'start' }, { ...status, data: { phase: 'searching', tool: 'web_search', step: 1 } }, text, { type: 'finish' }]
  const returned = await collect(persistAgentStream(source(parts), async checkpoint => { saves.push(checkpoint) }))
  assert.deepEqual(returned, parts)
  assert.deepEqual(saves, [{ completion: '测试回复', status: 'complete', error: null }])
  const reopened = JSON.stringify(saves)
  assert.ok(!reopened.includes('data-agent-status'))
  assert.ok(!reopened.includes('thinking'))
})
