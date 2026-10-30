import assert from 'node:assert/strict'
import test from 'node:test'
import { byoE2BKeyEnabled, e2bErrorCode, verifyE2BKey } from './e2b'

test('BYO flag is off unless exactly "1"', () => {
  for (const value of [undefined, '', '0', 'true', 'yes']) assert.equal(byoE2BKeyEnabled({ MIKKA_BYO_E2B_KEY: value }), false)
  assert.equal(byoE2BKeyEnabled({ MIKKA_BYO_E2B_KEY: '1' }), true)
})

test('verify maps E2B responses and sends the key only as X-API-Key', async () => {
  const seen: Array<{ url: string; headers: HeadersInit | undefined }> = []
  const fake = (status: number) => (async (url: string, init?: RequestInit) => { seen.push({ url, headers: init?.headers }); return new Response('{}', { status }) }) as unknown as typeof fetch
  assert.deepEqual(await verifyE2BKey('e2b_k', fake(200)), { ok: true })
  assert.deepEqual(await verifyE2BKey('e2b_k', fake(401)), { ok: false, code: 'invalid' })
  assert.deepEqual(await verifyE2BKey('e2b_k', fake(403)), { ok: false, code: 'invalid' })
  assert.deepEqual(await verifyE2BKey('e2b_k', fake(429)), { ok: false, code: 'rate_limited' })
  assert.deepEqual(await verifyE2BKey('e2b_k', fake(503)), { ok: false, code: 'unavailable' })
  assert.deepEqual(await verifyE2BKey('e2b_k', (async () => { throw new Error('net') }) as unknown as typeof fetch), { ok: false, code: 'unavailable' })
  assert.equal(seen[0].url, 'https://api.e2b.app/v2/sandboxes?limit=1')
  assert.deepEqual(seen[0].headers, { 'X-API-Key': 'e2b_k' })
  assert.deepEqual([401, 403, 429, 404, 500].map(e2bErrorCode), ['e2b_key_invalid', 'e2b_key_invalid', 'e2b_limit_reached', 'e2b_template_unavailable', 'e2b_unavailable'])
})
