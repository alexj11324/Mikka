import test from 'node:test'
import assert from 'node:assert/strict'
import { encode, encodeArgs, decode } from './wire'

test('dates, undefined and literal tag-shaped application objects round-trip', () => {
  const value = { at: new Date('2026-11-05T00:00:00.000Z'), absent: undefined, values: [null, false, 1, 'x', undefined], literal: { $mikka: 'date', value: 'not a date' } }
  assert.deepEqual(decode(JSON.parse(JSON.stringify(encode(value)))), value)
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
  const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value"}')
  const result = decode(encode(value)) as Record<string, unknown>
  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  assert.equal(Object.hasOwn(result, '__proto__'), true)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
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
