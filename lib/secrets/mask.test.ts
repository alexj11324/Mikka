import assert from 'node:assert/strict'
import test from 'node:test'
import { createSecretMasker, identityMasker, maskCredentials, maskDeep, maskStreamStep, MASK_MIN_LENGTH, withCredentialMasking } from './mask'
import { TASK_SECRET_CAPABILITY_PREFIX, TASK_SECRET_MAX_TOKEN_BYTES } from '@mikka/protocol/task-secrets'

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

// Fabricated credentials, assembled at runtime so no token-shaped literal sits in the repository.
const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
const fakeJwt = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ aud: 'fixture', exp: 1, iss: 'fixture' })}.${'Ab_cD-ef'.repeat(8)}`
const fakeInstallation = ['ghs', '1234567', fakeJwt].join('_')
const fakeClassic = ['ghp', 'x'.repeat(36)].join('_')
const fakePat = ['github', 'pat', '11AAAAAAA0' + 'y'.repeat(70)].join('_')

test('credential patterns: gh auth status output keeps no part of an installation token', () => {
  const mask = withCredentialMasking(identityMasker)
  // gh masks after the token's last underscore; a JWT signature contains `_`, so most of the token showed.
  const lastUnderscore = fakeInstallation.lastIndexOf('_')
  const ghShown = fakeInstallation.slice(0, lastUnderscore + 1) + '*'.repeat(fakeInstallation.length - lastUnderscore - 1)
  const output = `github.com\n  ✓ Logged in to github.com account mikka-github[bot] (GH_TOKEN)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: ${ghShown}\n`
  const masked = mask(output)
  assert.match(masked, /- Token: \[secret:github-token\]\**\n/)
  for (const part of [fakeInstallation.slice(0, 20), fakeJwt.split('.')[0], fakeJwt.split('.')[1]]) assert.ok(!masked.includes(part), 'no fragment of the token remains')
  assert.ok(masked.includes('mikka-github[bot]'), 'the rest of the output is untouched')
})

test('credential patterns: every GitHub token form and a bare JWT are masked whole', () => {
  const mask = withCredentialMasking(identityMasker)
  assert.equal(mask(`a ${fakeInstallation} b`), 'a [secret:github-token] b')
  assert.equal(mask(`x=${fakeClassic};`), 'x=[secret:github-token];')
  for (const prefix of ['gho', 'ghu', 'ghr']) assert.equal(mask(`${prefix}_${'z'.repeat(36)}`), '[secret:github-token]')
  assert.equal(mask(`"${fakePat}"`), '"[secret:github-token]"')
  assert.equal(mask(`Authorization: Bearer ${fakeJwt}`), 'Authorization: Bearer [secret:jwt]')
})

test('credential patterns leave ordinary text alone', () => {
  const mask = withCredentialMasking(identityMasker)
  for (const text of ['ghost_town and ghp_short', 'eyJ alone', 'see github_pat_ docs', 'git push origin mikka/zhix-13', 'sha 508682a1924a607ff19617e58efb58fb76550fa1'])
    assert.equal(mask(text), text)
})

test('credential patterns run after saved secrets, and maskDeep reaches them', () => {
  const mask = withCredentialMasking(createSecretMasker([{ name: 'T', value: 'tok_12345678' }]))
  assert.equal(mask(`tok_12345678 ${fakeClassic}`), '[secret:T] [secret:github-token]')
  assert.deepEqual(maskDeep({ output: `Token: ${fakeInstallation}` }, mask), { output: 'Token: [secret:github-token]' })
})

test('a credential split into deltas never leaves the stream step in plaintext', () => {
  const mask = withCredentialMasking(identityMasker)
  const text = `before ${fakeInstallation} middle ${fakeJwt} after ${fakePat} end`
  for (const size of [1, 2, 5, 13, Math.ceil(text.length / 3)]) {
    let pending = ''
    let out = ''
    for (let i = 0; i < text.length; i += size) {
      const step = maskStreamStep(mask, pending, text.slice(i, i + size))
      for (const part of [fakeInstallation.slice(0, 12), fakeJwt.slice(0, 12), fakePat.slice(0, 15)]) assert.ok(!step.release.includes(part), `size ${size}: released a credential fragment`)
      out += step.release
      pending = step.pending
    }
    out += maskStreamStep(mask, pending, '', true).release
    assert.equal(out, 'before [secret:github-token] middle [secret:jwt] after [secret:github-token] end', `size ${size}`)
  }
})

test('task capability generations are masked without registering each renewed bearer', () => {
  const mask = withCredentialMasking(identityMasker)
  for (let generation = 0; generation <= 100; generation++) {
    const token = `${TASK_SECRET_CAPABILITY_PREFIX}${Buffer.from(`synthetic-opaque-generation-${generation}`).toString('base64url')}`
    const encoded = Buffer.from(token).toString('base64')
    assert.equal(mask(`before ${token} and ${encoded} after`), 'before [secret:TASK_SECRET_CAPABILITY] and [secret:TASK_SECRET_CAPABILITY] after')
    assert.equal(maskCredentials(`${token} ${encoded}`, '[redacted]'), '[redacted] [redacted]')
    assert.deepEqual(maskDeep({ [token]: { result: encoded } }, mask), { '[secret:TASK_SECRET_CAPABILITY]': { result: '[secret:TASK_SECRET_CAPABILITY]' } })
  }
})

test('task capabilities retain complete raw and base64 coverage at every stream boundary', () => {
  const mask = withCredentialMasking(identityMasker)
  const token = `${TASK_SECRET_CAPABILITY_PREFIX}${Buffer.from('synthetic-capability-for-server-streaming').toString('base64url')}`
  for (const form of [token, Buffer.from(token).toString('base64')]) {
    const text = `before ${form} after`
    for (let split = 1; split < text.length; split++) {
      const first = maskStreamStep(mask, '', text.slice(0, split))
      if (split > 7 && split < 7 + form.length) assert.equal(first.release, 'before ')
      const second = maskStreamStep(mask, first.pending, text.slice(split))
      const final = maskStreamStep(mask, second.pending, '', true)
      assert.equal(first.release + second.release + final.release, 'before [secret:TASK_SECRET_CAPABILITY] after')
      assert.equal(final.pending, '')
    }
  }
})

test('maximum-size task capabilities remain masked with a finite streaming buffer', () => {
  const mask = withCredentialMasking(identityMasker)
  const token = TASK_SECRET_CAPABILITY_PREFIX + 'x'.repeat(TASK_SECRET_MAX_TOKEN_BYTES - TASK_SECRET_CAPABILITY_PREFIX.length)
  const maxHeld = 4 * Math.ceil(TASK_SECRET_MAX_TOKEN_BYTES / 3)
  for (const form of [token, Buffer.from(token).toString('base64')]) {
    let pending = ''
    for (let start = 0; start < form.length; start += 4096) {
      const result = maskStreamStep(mask, pending, form.slice(start, start + 4096))
      assert.equal(result.release, '')
      assert.ok(result.pending.length <= maxHeld)
      pending = result.pending
    }
    assert.deepEqual(maskStreamStep(mask, pending, '', true), { release: '[secret:TASK_SECRET_CAPABILITY]', pending: '' })
  }
})
