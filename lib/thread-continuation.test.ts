import assert from 'node:assert/strict'
import test from 'node:test'
import { continuationFollowUp, continuationNote } from './thread-continuation'
import { decideNewThread, NEW_THREAD_THRESHOLD } from './thread-switch'
import { runPrompt } from './run-prompt'

const failed = { status: 'failed', stopReason: 'error', error: 'tests failed', summary: 'Added the parser; two tests fail.', lastReply: 'Two tests still fail.' }

test('a thread\'s next run carries the note and how the thread last ended; a resumed session is sent only that part', () => {
  const note = continuationNote('Fix the two failing tests.', failed)
  assert.match(note, /^## More work in this thread/)
  assert.match(note, /What to do now:\nFix the two failing tests\./)
  assert.match(note, /Status: failed \(error\)/)
  assert.match(note, /Summary: Added the parser; two tests fail\./)
  assert.match(note, /do not repeat a push/)
  assert.match(continuationNote(undefined, { ...failed, summary: null, error: null, lastReply: null }), /What to do now: continue the task\./)
  const prompt = runPrompt('Parser', 'Write the parser.', null, note)
  assert.equal(continuationFollowUp(prompt), note)
  assert.equal(continuationFollowUp(runPrompt('Parser', 'Write the parser.', null, 'plain note')), null)
})

test('only a confident Decision API judgment of an explicit request starts a new thread', async () => {
  const asked: string[] = []
  const decide = (probability: number | null) => async (purpose: string, input: unknown) => {
    asked.push(purpose); assert.match(JSON.stringify(input), /换一个 session/)
    return probability === null ? null : { answers: new Map<string, unknown>([['new_thread', { type: 'predicate', name: 'new_thread', probability }]]) }
  }
  assert.equal(await decideNewThread('换一个 session 重新做', decide(0.95)), true)
  assert.equal(await decideNewThread('换一个 session 重新做', decide(NEW_THREAD_THRESHOLD - 0.01)), false)
  // Unavailable or failing judgment keeps the thread; it never falls back to keywords.
  assert.equal(await decideNewThread('换一个 session 重新做', decide(null)), false)
  assert.equal(await decideNewThread('换一个 session 重新做', async () => { throw new Error('down') }), false)
  assert.deepEqual([...new Set(asked)], ['thread-switch'])
})
