import assert from 'node:assert/strict'
import test from 'node:test'
import { createSecretMasker, identityMasker, maskDeep, MASK_MIN_LENGTH } from './mask'

const VALUE = 'sk_live_a+b/c=d?e&f 中'
test('masks raw, base64 (std/unpadded/url-safe) and URL-encoded forms', () => {
  const mask = createSecretMasker([{ name: 'STRIPE', value: VALUE }])
  const b64 = Buffer.from(VALUE).toString('base64')
  for (const form of [VALUE, b64, b64.replace(/=+$/, ''), b64.replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_'), encodeURIComponent(VALUE), encodeURI(VALUE), new URLSearchParams({ v: VALUE }).toString().slice(2)])
    assert.equal(mask(`a ${form} b`), 'a [secret:STRIPE] b', form)
})
test('values shorter than 8 are not masked; empty list is identity', () => {
  assert.equal(MASK_MIN_LENGTH, 8)
  assert.equal(createSecretMasker([{ name: 'S', value: '1234567' }]), identityMasker)
  assert.equal(createSecretMasker([{ name: 'S', value: '12345678' }])('x12345678y'), 'x[secret:S]y')
  assert.equal(createSecretMasker([]), identityMasker)
})
test('longer secrets win over secrets they contain', () => {
  const mask = createSecretMasker([{ name: 'SHORT', value: 'abcdefgh' }, { name: 'LONG', value: 'abcdefgh-ijkl' }])
  assert.equal(mask('abcdefgh-ijkl abcdefgh'), '[secret:LONG] [secret:SHORT]')
})
test('maskDeep walks arrays, objects and keys, leaves non-strings alone', () => {
  const mask = createSecretMasker([{ name: 'T', value: 'tok_12345678' }])
  assert.deepEqual(maskDeep({ a: ['tok_12345678', 1, null, true], tok_12345678: { b: 'x tok_12345678' } }, mask), { a: ['[secret:T]', 1, null, true], '[secret:T]': { b: 'x [secret:T]' } })
  const input = { a: 'tok_12345678' }
  assert.equal(maskDeep(input, identityMasker), input)
})

test('min length counts code points, not UTF-16 units', () => {
  assert.equal(createSecretMasker([{ name: 'E', value: '😀😀😀😀' }]), identityMasker, '4 code points (8 UTF-16 units) is too short')
  assert.equal(createSecretMasker([{ name: 'E', value: '😀😀😀😀😀😀😀😀' }])('x😀😀😀😀😀😀😀😀x'), 'x[secret:E]x')
})
