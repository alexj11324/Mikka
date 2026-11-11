import assert from 'node:assert/strict'
import test from 'node:test'
import { THREAD_SEARCH_LIMIT, threadSearchHits } from './thread-search'

const thread = (id: string, prompt: string, lastReply: string | null = null) => ({ id, prompt, lastReply })
const byName = (names: Record<string, string>) => (item: { id: string; prompt: string }) => names[item.id] ?? item.prompt

test('⌘K finds a thread by its name, its request or its last reply (D4/M10)', () => {
  const threads = [
    thread('a', '复现 Safari 17 登录页白屏，写一个失败的 Playwright 用例'),
    thread('b', 'Trim the bundle', 'Removed the polyfills'),
    thread('c', 'Model the routing table'),
  ]
  const name = byName({ c: '#12 开放平台按路由分级限流' })
  assert.deepEqual(threadSearchHits(threads, 'safari', name).map(hit => hit.thread.id), ['a'])
  assert.deepEqual(threadSearchHits(threads, 'polyfills', name).map(hit => hit.thread.id), ['b'])
  assert.deepEqual(threadSearchHits(threads, '限流', name).map(hit => hit.name), ['#12 开放平台按路由分级限流'])
  assert.deepEqual(threadSearchHits(threads, 'safari 用例', name).map(hit => hit.thread.id), ['a'], 'every word must match')
})

test('an empty query lists no threads, and a broad one is capped', () => {
  const many = Array.from({ length: 20 }, (_, index) => thread(String(index), `fix login ${index}`))
  assert.deepEqual(threadSearchHits(many, '  ', item => item.prompt), [])
  const hits = threadSearchHits(many, 'login', item => item.prompt)
  assert.equal(hits.length, THREAD_SEARCH_LIMIT)
  assert.equal(hits[0].thread.id, '0', 'keeps the shell’s newest-first order')
})

test('a task\'s attempts show as one thread, and none when the task is already listed', () => {
  const attempts = [
    { id: 'new', prompt: 'Order lookup times out', lastReply: null, issueId: 'task-3' },
    { id: 'old', prompt: 'Order lookup times out', lastReply: 'Added the index', issueId: 'task-3' },
    { id: 'chat', prompt: 'Order history export', lastReply: null, issueId: null },
  ]
  assert.deepEqual(threadSearchHits(attempts, 'order', item => item.prompt).map(hit => hit.thread.id), ['new', 'chat'])
  assert.deepEqual(threadSearchHits(attempts, 'order', item => item.prompt, new Set(['task-3'])).map(hit => hit.thread.id), ['chat'])
})
