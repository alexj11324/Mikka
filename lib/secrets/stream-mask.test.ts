// #438 QA: closing a streamed part in a later batch than its deltas (cross-batch), for every
// end kind (text-end, reasoning-end, finish, error, abort) and every split point.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createSecretMasker } from './mask'
import { maskStreamedChunks } from './stream-mask'

const SECRET = 'sk_live_0123456789abcdef'
const mask = createSecretMasker([{ name: 'A', value: SECRET }])
const TEXTS = [`hello ${SECRET} world`, `ends with ${SECRET}`, `ends with sk_live_0`, 'plain text only', `${SECRET}`]
const ENDS = ['text-end', 'reasoning-end', 'finish', 'error', 'abort'] as const

type Chunk = Record<string, unknown>
function run(text: string, end: typeof ENDS[number], cut: number, endAlone: boolean): Chunk[] {
  const kind = end === 'reasoning-end' ? 'reasoning' : 'text'
  const deltas: Chunk[] = [...text].map(ch => ({ type: `${kind}-delta`, id: 'p1', delta: ch }))
  const endChunk: Chunk = end.endsWith('-end') ? { type: end, id: 'p1' } : { type: end }
  const batches = endAlone ? [deltas.slice(0, cut), deltas.slice(cut), [endChunk]] : [deltas.slice(0, cut), [...deltas.slice(cut), endChunk]]
  const pending = new Map<string, string>()
  const out = batches.flatMap(batch => maskStreamedChunks(batch, mask, pending))
  assert.equal(pending.size, 0, 'nothing held after the part/run ends')
  return out
}

test('cross-batch closing: the full masked text comes out for every end kind and split', () => {
  let combos = 0
  for (const text of TEXTS) for (const end of ENDS) for (let cut = 0; cut <= text.length; cut++) for (const endAlone of [false, true]) {
    const out = run(text, end, cut, endAlone)
    const kind = end === 'reasoning-end' ? 'reasoning' : 'text'
    const joined = out.filter(c => c.type === `${kind}-delta`).map(c => c.delta as string).join('')
    const label = `${JSON.stringify(text)} ${end} cut=${cut} endAlone=${endAlone}`
    assert.equal(joined, mask(text), label)
    assert.ok(!JSON.stringify(out).includes(SECRET), label)
    assert.ok(out.some(c => c.type === end), `${label}: end chunk kept`)
    combos++
  }
  assert.ok(combos > 60)
})

test('QA repro: "hello [secret] world" closed by finish in a later batch keeps the last char', () => {
  const pending = new Map<string, string>()
  const text = `hello ${SECRET} world`
  const a = maskStreamedChunks([...text].map(ch => ({ type: 'text-delta', id: 't', delta: ch })), mask, pending)
  const b = maskStreamedChunks([{ type: 'finish' }], mask, pending)
  assert.equal([...a, ...b].filter(c => c.type === 'text-delta').map(c => c.delta).join(''), 'hello [secret:A] world')
  assert.deepEqual(b.at(-1), { type: 'finish' })
})

test('tool input held across batches is flushed as a tool-input-delta on run end', () => {
  const pending = new Map<string, string>()
  const a = maskStreamedChunks([{ type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"k":"sk_live_0' }], mask, pending)
  const b = maskStreamedChunks([{ type: 'abort' }], mask, pending)
  assert.equal([...a, ...b].filter(c => c.type === 'tool-input-delta').map(c => c.inputTextDelta).join(''), '{"k":"sk_live_0')
  assert.equal(pending.size, 0)
})
