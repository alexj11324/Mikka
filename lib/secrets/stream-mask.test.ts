// #438: masking a streamed part inside one event batch, for every end kind (text-end, reasoning-end,
// finish, error, abort, or just the end of the batch) and every delta size. Nothing is held between batches.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createSecretMasker } from './mask'
import { maskStreamedChunks } from './stream-mask'

const SECRET = 'sk_live_0123456789abcdef'
const mask = createSecretMasker([{ name: 'A', value: SECRET }])
const TEXTS = [`hello ${SECRET} world`, `ends with ${SECRET}`, `ends with sk_live_0`, 'plain text only', `${SECRET}`, `b64 ${Buffer.from(SECRET).toString('base64')} done`]
const ENDS = ['text-end', 'reasoning-end', 'finish', 'error', 'abort', null] as const

type Chunk = Record<string, unknown>

test('a value split over deltas of one batch is masked whole, for every end kind and delta size', () => {
  let combos = 0
  for (const text of TEXTS) for (const end of ENDS) for (const size of [1, 2, 5, text.length]) {
    const kind = end === 'reasoning-end' ? 'reasoning' : 'text'
    const deltas: Chunk[] = []
    for (let i = 0; i < text.length; i += size) deltas.push({ type: `${kind}-delta`, id: 'p1', delta: text.slice(i, i + size) })
    const endChunk: Chunk[] = end === null ? [] : [end.endsWith('-end') ? { type: end, id: 'p1' } : { type: end }]
    const out = maskStreamedChunks([...deltas, ...endChunk], mask)
    const label = `${JSON.stringify(text)} ${end} size=${size}`
    assert.equal(out.filter(c => c.type === `${kind}-delta`).map(c => c.delta as string).join(''), mask(text), label)
    for (const c of out) assert.ok(!String(c.delta ?? '').includes(SECRET.slice(0, 12)), `${label}: no delta carries the secret start`)
    if (end) assert.deepEqual(out.at(-1), endChunk[0], `${label}: end chunk kept`)
    assert.equal(out.length, deltas.length + endChunk.length, `${label}: no chunk added`)
    combos++
  }
  assert.ok(combos > 100)
})

test('two parts in one batch are held back independently', () => {
  const out = maskStreamedChunks([
    { type: 'text-delta', id: 'a', delta: 'x sk_live_0123' },
    { type: 'reasoning-delta', id: 'b', delta: 'y sk_live_' },
    { type: 'text-delta', id: 'a', delta: '456789abcdef z' },
    { type: 'reasoning-delta', id: 'b', delta: '0123456789abcdef' },
  ], mask)
  assert.equal(out.filter(c => c.id === 'a').map(c => c.delta).join(''), 'x [secret:A] z')
  assert.equal(out.filter(c => c.id === 'b').map(c => c.delta).join(''), 'y [secret:A]')
})

test('tool input held at the end of a batch is released on its last delta', () => {
  const out = maskStreamedChunks([{ type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"k":"sk_live_0' }], mask)
  assert.deepEqual(out, [{ type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"k":"sk_live_0' }])
})

test('S7: an end chunk that itself carries a secret is masked (text-end metadata, tool-input-available input, tool-input-error)', () => {
  for (const endChunk of [
    { type: 'text-end', id: 'p1', providerMetadata: { note: `raw ${SECRET}` } },
    { type: 'reasoning-end', id: 'p1', providerMetadata: { note: SECRET } },
    { type: 'tool-input-available', toolCallId: 'p1', toolName: 'bash', input: { command: `curl -H ${SECRET}` } },
    { type: 'tool-input-error', toolCallId: 'p1', toolName: 'bash', input: `curl ${SECRET}`, errorText: `bad ${SECRET}` },
  ] as Chunk[]) {
    const type = String(endChunk.type)
    const kind = type === 'reasoning-end' ? 'reasoning' : type.startsWith('tool') ? 'tool' : 'text'
    const delta: Chunk = kind === 'tool' ? { type: 'tool-input-delta', toolCallId: 'p1', inputTextDelta: 'x' } : { type: `${kind}-delta`, id: 'p1', delta: 'x' }
    for (const batches of [[[delta, endChunk]], [[delta], [endChunk]]]) {
      const out = JSON.stringify(batches.flatMap(batch => maskStreamedChunks(batch, mask)))
      assert.ok(!out.includes(SECRET) && !out.includes(SECRET.slice(0, 10)), `${type}: end chunk leaked`)
      assert.match(out, /\[secret:A\]/, type)
    }
  }
})
