import test from 'node:test'
import assert from 'node:assert/strict'
import { Schema } from '@tiptap/pm/model'
import { encode, encodeArgs, decode } from './wire'

test('dates, undefined and literal tag-shaped application objects round-trip', () => {
  const value = { at: new Date('2026-11-05T00:00:00.000Z'), absent: undefined, values: [null, false, 1, 'x', undefined], literal: { $mikka: 'date', value: 'not a date' } }
  assert.deepEqual(decode(JSON.parse(JSON.stringify(encode(value)))), value)
})

test('task autosave can send an edited ProseMirror document with dictionary attributes', async () => {
  const schema = new Schema({ nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', attrs: { textAlign: { default: null } } },
    text: {},
  } })
  const content = schema.node('doc', null, [schema.node('paragraph', { textAlign: 'center' }, schema.text('Updated'))]).toJSON()
  assert.equal(Object.getPrototypeOf(content.content[0].attrs), null)
  const args = [{ id: 'task', revision: 3, content }]
  const encoded = await encodeArgs(args)
  assert.deepEqual(decode(JSON.parse(JSON.stringify(encoded))), JSON.parse(JSON.stringify(args)))
  assert.throws(() => encode(Object.create({ inherited: true })), /desktop_rpc_value_invalid/)
})

test('ordinary chat JSON has no serialization overhead', () => {
  const value = { items: Array.from({ length: 400 }, (_, i) => ({ id: `message-${i}`, text: 'x'.repeat(1000), kind: 'assistant', parts: ['hello', i] })), version: 'a'.repeat(32) }
  assert.equal(JSON.stringify(encode(value)), JSON.stringify(value))
})

test('tag decoding rejects malformed values, duplicates and excessive nesting', () => {
  for (const value of [{ $mikka: 'date', value: 'yesterday' }, { $mikka: 'undefined', extra: true }, { $mikka: 'object', value: [['id', 1], ['id', 2]] }, { $mikka: 'unknown', value: [] }]) assert.throws(() => decode(value))
  let deep: unknown = null
  for (let i = 0; i < 66; i++) deep = [deep]
  assert.throws(() => decode(deep))
  for (const value of [NaN, Infinity, new Date('invalid'), new Map(), () => null]) assert.throws(() => encode(value))
})

test('own __proto__ properties remain data without changing prototypes', () => {
  const plain = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value"}')
  for (const value of [plain, Object.assign(Object.create(null), plain, { $mikka: 'literal' })]) {
    const result = decode(encode(value)) as Record<string, unknown>
    assert.equal(Object.getPrototypeOf(result), Object.prototype)
    assert.equal(Object.hasOwn(result, '__proto__'), true)
    assert.deepEqual(result, JSON.parse(JSON.stringify(value)))
    assert.equal(({} as Record<string, unknown>).polluted, undefined)
  }
})

test('the avatar FormData round-trips its bytes and rejects oversized files', async () => {
  const form = new FormData()
  form.set('avatar', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'avatar.png')
  const [result] = decode(JSON.parse(JSON.stringify(await encodeArgs([form])))) as FormData[]
  const file = result.get('avatar') as File
  assert.equal(file.type, 'image/png'); assert.equal(file.name, 'avatar.png')
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([137, 80, 78, 71]))
  form.set('avatar', new Blob([new Uint8Array(200 * 1024 + 1)]), 'large.png')
  await assert.rejects(encodeArgs([form]))
})
