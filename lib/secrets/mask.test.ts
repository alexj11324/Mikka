import assert from 'node:assert/strict'
import test from 'node:test'
import { createSecretMasker, identityMasker, maskDeep, maskStreamStep, MASK_MIN_LENGTH } from './mask'

const VALUE = 'sk_live_a+b/c=d?e&f 中'
test('masks the raw value and its standard base64; other encodings are left alone', () => {
  const mask = createSecretMasker([{ name: 'STRIPE', value: VALUE }])
  const b64 = Buffer.from(VALUE).toString('base64')
  for (const form of [VALUE, b64]) assert.equal(mask(`a ${form} b`), 'a [secret:STRIPE] b', form)
  for (const form of [b64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''), encodeURIComponent(VALUE), Buffer.from(VALUE).toString('hex')])
    assert.equal(mask(`a ${form} b`), `a ${form} b`, `not matched: ${form}`)
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

test('#438 A: a secret split into deltas never leaves the stream step in plaintext', () => {
  const value = 'sk_live_streamsecret_42'
  const mask = createSecretMasker([{ name: 'S', value }])
  const text = `before ${value} middle ${Buffer.from(value).toString('base64')} after`
  for (const size of [1, 2, 3, 7, Math.ceil(text.length / 2)]) {
    let pending = ''
    let out = ''
    const released: string[] = []
    for (let i = 0; i < text.length; i += size) {
      const step = maskStreamStep(mask, pending, text.slice(i, i + size))
      pending = step.pending
      released.push(step.release)
      out += step.release
    }
    out += maskStreamStep(mask, pending, '', true).release
    assert.equal(out, 'before [secret:S] middle [secret:S] after', `size ${size}`)
    for (const piece of released) assert.ok(!piece.includes('sk_live_s'), `size ${size}: no released piece starts the secret`)
  }
})
