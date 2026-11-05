import assert from 'node:assert/strict'
import test from 'node:test'
import { dockerRequestUrl } from './docker-ingress.mjs'

const origin = 'https://3000-001m6p98ev958vppx9366vfp8ea.sbx.sandboxes-cloud.docker.com'
const host = new URL(origin).host
const request = (extra = [], url = '/mikka/en?next=%2Fmikka%3Fsection%3Dplugins') => ({ url, rawHeaders: ['Host', host, ...extra] })
const rejected = (value, code) => assert.throws(() => dockerRequestUrl(value, origin), error => error.code === code)

test('Docker ingress binds relative requests to the fixed attested HTTPS origin without mutating headers', () => {
  const input = request(['X-Forwarded-Host', host, 'X-Forwarded-Proto', 'https', 'X-Forwarded-Port', '443'])
  const before = structuredClone(input)
  assert.equal(dockerRequestUrl(input, origin), `${origin}${input.url}`)
  assert.deepEqual(input, before)
  assert.equal(dockerRequestUrl(request([], '/'), origin), `${origin}/`)
  assert.equal(dockerRequestUrl(request([], '/mikka/api/desktop/return?code=synthetic&state=synthetic'), origin), `${origin}/mikka/api/desktop/return?code=synthetic&state=synthetic`)
})

test('only an explicitly allowed Docker origin on HTTPS 443 is eligible', () => {
  for (const candidate of [origin.replace('https:', 'http:'), `${origin}:443`, `${origin}:8443`, `${origin}/`, `${origin}/mikka`, `${origin}?host=evil.invalid`, origin.replace('001m6p98ev958vppx9366vfp8ea', 'foreign'), 'https://app.aspectlylabs.com', `https://user@${host}`]) {
    assert.throws(() => dockerRequestUrl(request(), candidate))
  }
})

test('actual duplicate, missing, foreign, port-bearing and deceptive Host fields are rejected', () => {
  for (const rawHeaders of [[], ['Host', 'foreign.invalid'], ['Host', `${host}.evil.invalid`], ['Host', `${host}:443`], ['Host', `${host}:3000`], ['Host', ` ${host}`], ['Host', `${host},foreign.invalid`], ['Host', host, 'hOsT', host], ['Host', host, 'Host', 'foreign.invalid']]) {
    rejected({ url: '/mikka', rawHeaders, headers: { host } }, 'DOCKER_INGRESS_HOST_REJECTED')
  }
})

test('Forwarded accepts consistent quoted or multi-hop values without promoting them to authority', () => {
  for (const value of [`for=192.0.2.1;proto=https;host=${host}`, `for="[2001:db8::1]:1234";host="${host}";proto="https"`, `for=192.0.2.1;host=${host};proto=https, for=_internal;proto=https;host=${host}`, 'for="opaque,semicolon;value"']) {
    const input = request(['Forwarded', value])
    assert.equal(dockerRequestUrl(input, origin), `${origin}${input.url}`)
  }
  rejected({ url: '/mikka', rawHeaders: ['Host', 'foreign.invalid', 'Forwarded', `host=${host};proto=https`] }, 'DOCKER_INGRESS_HOST_REJECTED')
})

test('Forwarded ambiguity and any inconsistent proxy authority are rejected before Next', () => {
  for (const extra of [
    ['Forwarded', 'host=foreign.invalid;proto=https'], ['Forwarded', `host=${host};proto=http`],
    ['Forwarded', `host=${host};host=${host}`], ['Forwarded', `host="${host}`],
    ['Forwarded', `host=${host},host=foreign.invalid`], ['Forwarded', `host=${host};proto=https,proto=http`],
    ['Forwarded', `host=${host};proto=https;`], ['Forwarded', `host=${host}`, 'Forwarded', `host=${host}`],
    ['X-Forwarded-Host', 'foreign.invalid'], ['X-Forwarded-Host', `${host},${host}`],
    ['X-Forwarded-Host', host, 'x-forwarded-host', host], ['X-Forwarded-Proto', 'http'],
    ['X-Forwarded-Proto', 'https,http'], ['X-Forwarded-Port', '3000'],
  ]) rejected(request(extra), 'DOCKER_INGRESS_FORWARDED_REJECTED')
})

test('absolute, network-path and malformed targets cannot change the validated request origin', () => {
  for (const target of ['https://foreign.invalid/mikka', `${origin}/mikka`, '//foreign.invalid/mikka', '/\\foreign.invalid/mikka', '*', '', '/mikka#ignored', '/mikka bad', '/mikka\r\nHost:foreign.invalid', '/mikka/\0', `/${'x'.repeat(16_384)}`]) {
    rejected(request([], target), 'DOCKER_INGRESS_TARGET_REJECTED')
  }
})

test('malformed or oversized original header lists fail with a safe code only', () => {
  for (const rawHeaders of [undefined, ['Host'], ['Host', 42], [' Host', host], ['Host', host, 'x-bad', 'a\r\nHost:foreign.invalid'], Array(258).fill('a'), ['Host', host, 'x-large', 'a'.repeat(65_537)]]) {
    rejected({ url: '/mikka', rawHeaders }, 'DOCKER_INGRESS_HEADERS_INVALID')
  }
  const privateValue = 'synthetic-private-header-never-log'
  assert.throws(() => dockerRequestUrl(request(['X-Forwarded-Host', privateValue]), origin), error => !error.message.includes(privateValue) && error.code === 'DOCKER_INGRESS_FORWARDED_REJECTED')
})
