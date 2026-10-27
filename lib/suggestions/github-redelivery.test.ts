import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { failedDeliveries, githubAppJwt, nextCursor, redeliverFailedGitHubWebhooks, type GitHubDelivery } from './github-redelivery'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString())

test('the App JWT is RS256, issued by the App, and expires within 10 minutes', () => {
  const now = new Date('2026-10-27T08:00:00Z')
  // A key stored on one line with literal \n still signs.
  const token = githubAppJwt('4840908', privateKey.replace(/\n/g, '\\n'), now)
  const [header, claims, signature] = token.split('.')
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' })
  const { iat, exp, iss } = decode(claims)
  assert.equal(iss, '4840908')
  assert.equal(iat, now.getTime() / 1000 - 60)
  assert.ok(exp > now.getTime() / 1000 && exp - iat <= 600)
  assert.equal(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')), true)
})

const at = (minutesAgo: number) => new Date(Date.parse('2026-10-27T08:00:00Z') - minutesAgo * 60_000).toISOString()
const delivery = (id: number, guid: string, minutesAgo: number, status: number, event = 'pull_request'): GitHubDelivery => ({ id, guid, delivered_at: at(minutesAgo), redelivery: id > 100, status_code: status, event })

test('only failed suggestion deliveries in the window are redelivered, once per guid', () => {
  const since = new Date(at(180))
  const picked = failedDeliveries([
    delivery(1, 'a', 30, 503),
    delivery(2, 'b', 40, 503), delivery(102, 'b', 20, 202), // a redelivery already got through
    delivery(3, 'c', 50, 0), delivery(103, 'c', 10, 500), // timed out, then failed again: send the latest once
    delivery(4, 'd', 60, 200),
    delivery(5, 'e', 240, 503), // outside the window
    delivery(6, 'f', 30, 503, 'push'), // not an event that feeds suggestions
  ], since)
  assert.deepEqual(picked.map(item => item.id), [1, 103])
  assert.equal(failedDeliveries([delivery(1, 'a', 30, 503), delivery(2, 'b', 31, 503)], since, 1).length, 1)
})

test('reads the next page cursor from the Link header', () => {
  assert.equal(nextCursor('<https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_123>; rel="next"'), 'v1_123')
  assert.equal(nextCursor('<https://api.github.com/app/hook/deliveries?cursor=x>; rel="prev"'), null)
  assert.equal(nextCursor(null), null)
})

test('does nothing without the App credentials', async () => {
  let calls = 0
  const result = await redeliverFailedGitHubWebhooks({ env: { GITHUB_APP_ID: '4840908' }, fetcher: (async () => { calls++; return new Response('[]') }) as typeof fetch })
  assert.equal(result.configured, false)
  assert.equal(calls, 0)
})

test('redelivers each failed delivery through the attempts endpoint', async () => {
  const now = new Date('2026-10-27T08:00:00Z')
  const posted: string[] = []
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(String(url)); return new Response(null, { status: 202 }) }
    return Response.json([delivery(7, 'g', 30, 503), delivery(8, 'h', 30, 200)])
  }) as typeof fetch
  const result = await redeliverFailedGitHubWebhooks({ now, env: { GITHUB_APP_ID: '4840908', GITHUB_APP_PRIVATE_KEY: privateKey }, fetcher })
  assert.deepEqual(posted, ['https://api.github.com/app/hook/deliveries/7/attempts'])
  assert.deepEqual(result, { configured: true, scanned: 2, failed: 1, redelivered: 1, errors: 0 })
})
