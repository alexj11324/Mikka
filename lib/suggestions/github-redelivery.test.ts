import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { failedDeliveries, fairRedeliveries, githubAppJwt, nextCursor, redeliverFailedGitHubWebhooks, type GitHubDelivery } from './github-redelivery'

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
const delivery = (id: number, guid: string, minutesAgo: number, status: number, event = 'pull_request'): GitHubDelivery => ({ id: String(id), guid, delivered_at: at(minutesAgo), redelivery: id > 100, status_code: status, event })

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
  assert.deepEqual(picked.map(item => item.id), ['1', '103'])
  assert.equal(failedDeliveries([delivery(1, 'a', 30, 503), delivery(2, 'b', 31, 503)], since, 1).length, 1)
  // CI deliveries are only handled, and redelivered, with MIKKA_CI_RESUME_ENABLED on.
  assert.equal(failedDeliveries([delivery(7, 'ci', 30, 503, 'workflow_run')], since).length, 0)
  assert.equal(failedDeliveries([delivery(7, 'ci', 30, 503, 'workflow_run')], since, undefined, true)[0]?.id, '7')
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

test('preserves a raw 19-digit delivery ID in the redelivery URL', async () => {
  const now = new Date('2026-10-27T08:00:00Z')
  const posted: string[] = []
  const raw = '[{"id":3850587977317089288,"guid":"large-id","delivered_at":"2026-10-27T07:30:00Z","redelivery":false,"status_code":503,"event":"pull_request"}]'
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(String(url)); return new Response(null, { status: 202 }) }
    return new Response(raw, { headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const result = await redeliverFailedGitHubWebhooks({ now, env: { GITHUB_APP_ID: '4840908', GITHUB_APP_PRIVATE_KEY: privateKey }, fetcher })
  assert.deepEqual(posted, ['https://api.github.com/app/hook/deliveries/3850587977317089288/attempts'])
  assert.deepEqual(result, { configured: true, scanned: 1, failed: 1, redelivered: 1, errors: 0 })
})

test('reads beyond ten pages for failures in the window and still redelivers at most 25', async () => {
  const now = new Date('2026-10-27T08:00:00Z')
  const posted: string[] = []
  const cursors: (string | null)[] = []
  const rawFailure = '{"id":3850587977317089288,"guid":"page-eleven","delivered_at":"2026-10-27T07:00:00Z","redelivery":false,"status_code":503,"event":"pull_request"}'
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(String(url)); return new Response(null, { status: 202 }) }
    cursors.push(new URL(url).searchParams.get('cursor'))
    const page = cursors.length
    if (page <= 10) return Response.json([delivery(page, `succeeded-${page}`, page * 5, 202)], {
      headers: { link: `<https://api.github.com/app/hook/deliveries?cursor=page-${page + 1}>; rel="next"` },
    })
    assert.equal(page, 11)
    return new Response(`[${rawFailure},${Array.from({ length: 29 }, (_, index) => JSON.stringify(delivery(1000 + index, `failed-${index}`, 60, 503))).join(',')}]`)
  }) as typeof fetch
  const result = await redeliverFailedGitHubWebhooks({ now, env: { GITHUB_APP_ID: '4840908', GITHUB_APP_PRIVATE_KEY: privateKey }, fetcher })
  assert.deepEqual(cursors, [null, ...Array.from({ length: 10 }, (_, index) => `page-${index + 2}`)])
  assert.equal(posted[0], 'https://api.github.com/app/hook/deliveries/3850587977317089288/attempts')
  assert.equal(posted.length, 25)
  assert.deepEqual(result, { configured: true, scanned: 40, failed: 30, redelivered: 25, errors: 0 })
})

test('stops at the three-hour boundary even when the page has another cursor', async () => {
  const now = new Date('2026-10-27T08:00:00Z')
  let pages = 0
  const posted: string[] = []
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(String(url)); return new Response(null, { status: 202 }) }
    pages++
    assert.equal(pages, 1)
    return Response.json([delivery(1, 'in-window', 180, 503), delivery(2, 'too-old', 181, 503)], {
      headers: { link: '<https://api.github.com/app/hook/deliveries?cursor=older>; rel="next"' },
    })
  }) as typeof fetch
  const result = await redeliverFailedGitHubWebhooks({ now, env: { GITHUB_APP_ID: '4840908', GITHUB_APP_PRIVATE_KEY: privateKey }, fetcher })
  assert.deepEqual(posted, ['https://api.github.com/app/hook/deliveries/1/attempts'])
  assert.deepEqual(result, { configured: true, scanned: 2, failed: 1, redelivered: 1, errors: 0 })
})

test('reports rejected redelivery attempts as errors', async () => {
  const now = new Date('2026-10-27T08:00:00Z')
  const fetcher = (async (_url: string | URL, init?: RequestInit) => init?.method === 'POST'
    ? new Response(null, { status: 500 })
    : Response.json([delivery(7, 'failed', 30, 503)])) as typeof fetch
  const result = await redeliverFailedGitHubWebhooks({ now, env: { GITHUB_APP_ID: '4840908', GITHUB_APP_PRIVATE_KEY: privateKey }, fetcher })
  assert.deepEqual(result, { configured: true, scanned: 1, failed: 1, redelivered: 0, errors: 1 })
})

test('rejects an incomplete delivery scan without posting redeliveries', async () => {
  const now = new Date('2026-10-27T08:00:00Z')
  let pages = 0
  const fetcher = (async (_url: string | URL, init?: RequestInit) => {
    assert.notEqual(init?.method, 'POST')
    if (++pages === 1) return Response.json([delivery(7, 'failed', 30, 503)], {
      headers: { link: '<https://api.github.com/app/hook/deliveries?cursor=next>; rel="next"' },
    })
    return new Response(null, { status: 403 })
  }) as typeof fetch
  await assert.rejects(redeliverFailedGitHubWebhooks({ now, env: { GITHUB_APP_ID: '4840908', GITHUB_APP_PRIVATE_KEY: privateKey }, fetcher }), /GitHub delivery log answered 403/)
  assert.equal(pages, 2)
})

test('CI failures and business notifications share the bounded redelivery budget', () => {
  const rows = [...Array.from({ length: 30 }, (_, i) => delivery(i, `ci-${i}`, 30, 503, 'workflow_run')), delivery(100, 'business', 1, 503)]
  const picked = fairRedeliveries(rows)
  assert.equal(picked.length, 25)
  assert.ok(picked.some(row => row.guid === 'business'))
})
