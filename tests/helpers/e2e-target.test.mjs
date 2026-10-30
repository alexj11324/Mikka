import assert from 'node:assert/strict'
import test from 'node:test'
import { e2eTargetParts, isE2eTarget, assertE2eTarget } from './e2e-target.mjs'

test('isE2eTarget accepts loopback *_e2e databases on any port', () => {
  for (const ok of [
    'postgres://fac@127.0.0.1:55594/fac_overnight_e2e',
    'postgresql://e2e:local@127.0.0.1:5432/mikka_e2e',
    'postgres://localhost/x_e2e',
    'postgres://u:p@[::1]:6543/A_B_9_e2e',
  ]) assert.equal(isE2eTarget(ok), true, ok)
  assert.deepEqual(e2eTargetParts('postgres://fac@127.0.0.1:55594/fac_overnight_e2e'), { host: '127.0.0.1', database: 'fac_overnight_e2e' })
})

test('isE2eTarget rejects each guard weakening directly', () => {
  const cases = {
    // _e2e$ anchor
    anchor: ['postgres://127.0.0.1/mikka_e2e_prod', 'postgres://127.0.0.1/mikka_e2ex'],
    // host check
    host: ['postgres://db.internal/mikka_e2e', 'postgres://10.0.0.5:5432/mikka_e2e', 'postgres://127.0.0.2/mikka_e2e', 'postgres://localhost.evil.com/x_e2e'],
    // URL options (pg lets ?host= / ?options= override the target)
    query: ['postgres://127.0.0.1/mikka_e2e?host=prod.internal', 'postgres://127.0.0.1/mikka_e2e?options=x', 'postgres://127.0.0.1/mikka_e2e?', 'postgres://127.0.0.1/mikka_e2e#x'],
    // name charset
    charset: ['postgres://127.0.0.1/mikka-prod_e2e', 'postgres://127.0.0.1/a.b_e2e', 'postgres://127.0.0.1/prod%2F_e2e', 'postgres://127.0.0.1/a/b_e2e', 'postgres://127.0.0.1/_e2e'],
    // protocol
    protocol: ['https://127.0.0.1/mikka_e2e', 'mysql://127.0.0.1/mikka_e2e', 'file:///mikka_e2e'],
    // whitespace / non-string
    trim: [' postgres://127.0.0.1/mikka_e2e', 'postgres://127.0.0.1/mikka_e2e\n', '', undefined, null, 42],
  }
  for (const [kind, values] of Object.entries(cases))
    for (const value of values) assert.equal(isE2eTarget(value), false, `${kind}: ${String(value)}`)
  assert.throws(() => assertE2eTarget('postgres://db.internal/mikka_e2e'), /_e2e/)
})

test('e2e target checks run on decoded host and database', () => {
  assert.equal(e2eTargetParts('postgres://127.0.0.1/mikka%5fe2e')?.database, 'mikka_e2e')
  // pg decodes the host too, so the guard must judge the decoded loopback host.
  assert.equal(e2eTargetParts('postgres://127%2e0%2e0%2e1/mikka_e2e')?.host, '127.0.0.1')
  for (const url of [
    'postgres://127.0.0.1%2e/mikka_e2e',
    'postgres://127.0.0.1%2eevil.com/mikka_e2e',
    'postgres://127.0.0.1/x%2fmikka_e2e',
    'postgres://127.0.0.1/mikka%2de2e',
    'postgres://127.0.0.1/mikka_E2E',
    'postgres://127.0.0.1/MIKKA_e2E',
  ]) assert.equal(isE2eTarget(url), false, url)
})
