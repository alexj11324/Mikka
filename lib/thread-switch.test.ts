import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideNewThread, NEW_THREAD_THRESHOLD } from './thread-switch'

const judged = (probability: number) => async () => ({ answers: new Map<string, unknown>([['new_thread', { type: 'predicate', probability }]]) })

test('only a confident judgment that the person asked starts a new thread', async () => {
  assert.equal(await decideNewThread('另开一个线程，用 Codex 重新做', judged(0.95)), true)
  assert.equal(await decideNewThread('再加一节安装说明', judged(0.05)), false)
  assert.equal(await decideNewThread('嗯，重新来一下？', judged(NEW_THREAD_THRESHOLD - 0.01)), false, 'below the threshold keeps the thread')
  assert.equal(await decideNewThread('换个线程', judged(NEW_THREAD_THRESHOLD)), true)
})

test('no judgment keeps the thread', async () => {
  assert.equal(await decideNewThread('另开一个线程', async () => null), false)
  assert.equal(await decideNewThread('另开一个线程', async () => { throw new Error('decisions down') }), false)
  assert.equal(await decideNewThread('另开一个线程', async () => ({ answers: new Map([['new_thread', { type: 'choice', choice: 'yes' }]]) })), false)
})

test("the person's words go to the judge as data, cut to a bounded length", async () => {
  let sent = ''
  await decideNewThread('x'.repeat(9000), async (_purpose, input) => { sent = String((input as { text: string }).text); return null })
  assert.match(sent, /^Person's message:\n<message>\nx{8000}\n<\/message>$/)
})
