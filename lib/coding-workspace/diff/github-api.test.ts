import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import type { RequestBudget } from '../../request-budget'
import { GitHubDiffClient } from './github-api'

const path = '/repos/fixture/review/git/commits/0123456789012345678901234567890123456789'
const token = 'fixture-viewer-credential'
const code = (expected: string) => (error: unknown) =>
  (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError) && error.code === expected

function fixture(t: TestContext, answer: (url: URL, init: RequestInit) => Response | Promise<Response>,
  budget: RequestBudget = { deadline: Date.now() + 30_000 }) {
  const calls: { url: URL; init: RequestInit }[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(init.redirect, 'error')
    assert.equal(init.credentials, 'omit')
    assert.equal(init.cache, 'no-store')
    const headers = new Headers(init.headers)
    assert.equal(headers.get('authorization'), `Bearer ${token}`)
    assert.equal(headers.get('accept'), 'application/vnd.github+json')
    assert.equal(headers.get('x-github-api-version'), '2022-11-28')
    assert.ok(init.signal instanceof AbortSignal)
    return answer(url, init)
  })
  return { client: new GitHubDiffClient(token, budget), calls }
}

function streamed(bytes: Uint8Array, status = 200) {
  let sent = false, cancelled = 0
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) controller.close()
      else { sent = true; controller.enqueue(bytes) }
    },
    cancel() { cancelled++ },
  }, { highWaterMark: 0 }), { status, headers: { 'content-length': '0' } })
  return { response, cancelled: () => cancelled }
}

test('GitHub Diff uses a fixed authenticated JSON origin and never follows returned URLs', async t => {
  const f = fixture(t, () => Response.json({ raw_url: 'https://raw.githubusercontent.com/other/private/main/file',
    download_url: 'https://outside.invalid/source' }, { headers: {
    link: '<https://outside.invalid/next?token=do-not-follow>; rel="next"',
  } }))
  const result = await f.client.get(path)
  assert.equal(result.next, true)
  assert.deepEqual(result.value, { raw_url: 'https://raw.githubusercontent.com/other/private/main/file',
    download_url: 'https://outside.invalid/source' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]!.url.href, `https://api.github.com${path}`)
})

test('arbitrary origins, raw URLs, fragments and traversals are rejected before credentials leave', async t => {
  for (const invalid of [
    'https://api.github.com/repos/fixture/review/git/blobs/object',
    'https://raw.githubusercontent.com/fixture/review/main/file', '//outside.invalid/source', '/user',
    '/repos/fixture/review/../../other/private', '/repos/fixture/review/./git/blobs/object',
    '/repos/fixture/review/git/blobs/object#fragment', '/repos/fixture/review\\outside',
    '/repos/fixture/review/%2e%2e/%2e%2e/other/private',
  ]) await t.test(invalid, async t => {
    const f = fixture(t, () => Response.json({}))
    await assert.rejects(f.client.get(invalid), code('workspace_limit_exceeded'))
    assert.equal(f.calls.length, 0)
  })
})

test('a redirect response is never followed or accepted as source', async t => {
  const f = fixture(t, () => new Response('{}', { status: 302, headers: { location: 'https://outside.invalid/private' } }))
  await assert.rejects(f.client.get(path), code('workspace_review_github_unavailable'))
  assert.equal(f.calls.length, 1)
})

test('the request budget admits exactly 48 HTTP reads and rejects the next before fetch', async t => {
  const f = fixture(t, () => Response.json({ ok: true }))
  for (let index = 0; index < 48; index++) assert.deepEqual((await f.client.get(path)).value, { ok: true })
  await assert.rejects(f.client.get(path), code('workspace_limit_exceeded'))
  assert.equal(f.calls.length, 48)
})

test('per-body and aggregate limits measure streamed bytes, including error bodies', async t => {
  for (const [label, length, status, limit] of [
    ['default success body', 4 * 1024 * 1024 + 1, 200, undefined],
    ['caller body cap', 1025, 200, 1024],
    ['error body cap', 64 * 1024 + 1, 403, undefined],
  ] as const) await t.test(label, async t => {
    const stream = streamed(Buffer.alloc(length, 32), status)
    const f = fixture(t, () => stream.response)
    await assert.rejects(f.client.get(path, limit), code('workspace_limit_exceeded'))
    assert.equal(stream.cancelled(), 1, 'the oversized body reader is cancelled')
    assert.equal(f.calls.length, 1)
  })
  await t.test('exactly 32 MiB is allowed; the next actual byte budget is refused', async t => {
    const body = `"${'x'.repeat(4 * 1024 * 1024 - 2)}"`
    const f = fixture(t, () => new Response(body))
    for (let index = 0; index < 8; index++) {
      const result = await f.client.get(path)
      assert.equal(typeof result.value, 'string')
      assert.equal((result.value as string).length, 4 * 1024 * 1024 - 2)
    }
    await assert.rejects(f.client.get(path), code('workspace_limit_exceeded'))
    assert.equal(f.calls.length, 9)
  })
})

test('expired or cancelled admission sends no request and a deadline crossed in a body cancels the reader', async t => {
  await t.test('already expired', async t => {
    const f = fixture(t, () => Response.json({}), { deadline: Date.now() - 1 })
    await assert.rejects(f.client.get(path), code('workspace_review_github_unavailable'))
    assert.equal(f.calls.length, 0)
  })
  await t.test('already cancelled', async t => {
    const controller = new AbortController(), reason = new DOMException('Fixture cancellation', 'AbortError')
    controller.abort(reason)
    const f = fixture(t, () => Response.json({}), { deadline: Date.now() + 10_000, signal: controller.signal })
    await assert.rejects(f.client.get(path), code('workspace_review_github_unavailable'))
    assert.equal(f.calls.length, 0)
  })
  await t.test('caller cancellation is connected to the actual fetch signal', async t => {
    const controller = new AbortController()
    const f = fixture(t, (_url, init) => {
      assert.equal(init.signal!.aborted, false)
      controller.abort()
      assert.equal(init.signal!.aborted, true)
      throw new DOMException('Fixture cancellation', 'AbortError')
    }, { deadline: Date.now() + 10_000, signal: controller.signal })
    await assert.rejects(f.client.get(path), code('workspace_review_github_unavailable'))
    assert.equal(f.calls.length, 1)
  })
  await t.test('body deadline', async t => {
    let now = 1000, cancelled = 0
    t.mock.method(Date, 'now', () => now)
    const f = fixture(t, () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { now = 3000; controller.enqueue(Buffer.from('{}')) },
      cancel() { cancelled++ },
    }, { highWaterMark: 0 })), { deadline: 2000 })
    await assert.rejects(f.client.get(path), code('workspace_review_github_unavailable'))
    assert.equal(cancelled, 1)
  })
})

test('HTTP authorization, source conflicts and transient limits retain distinct closed error codes', async t => {
  for (const [label, status, headers, message, expected] of [
    ['401', 401, {}, 'Bad credentials', 'workspace_review_github_forbidden'],
    ['403 authorization', 403, {}, 'Resource not accessible by integration', 'workspace_review_github_forbidden'],
    ['404 private or missing', 404, {}, 'Not Found', 'workspace_review_github_forbidden'],
    ['409 source conflict', 409, {}, 'Git Repository is empty.', 'workspace_snapshot_outdated'],
    ['422 validation', 422, {}, 'Validation Failed', 'workspace_review_github_unavailable'],
    ['429', 429, {}, 'Too many requests', 'workspace_review_github_unavailable'],
    ['503', 503, {}, 'Service unavailable', 'workspace_review_github_unavailable'],
    ['403 exhausted quota', 403, { 'x-ratelimit-remaining': '0' }, 'Forbidden', 'workspace_review_github_unavailable'],
    ['403 secondary limit', 403, {}, 'You have exceeded a secondary rate limit.', 'workspace_review_github_unavailable'],
    ['403 abuse detection', 403, {}, 'Abuse detection mechanism', 'workspace_review_github_unavailable'],
    ['retry-after', 403, { 'retry-after': '60' }, 'Forbidden', 'workspace_review_github_unavailable'],
  ] as const) await t.test(label, async t => {
    const f = fixture(t, () => Response.json({ message }, { status, headers }))
    await assert.rejects(f.client.get(path), error => {
      assert.ok(code(expected)(error))
      assert.ok(!String(error).includes(token))
      assert.ok(!String(error).includes(message))
      return true
    })
    assert.equal(f.calls.length, 1, 'the provider does not retry an error')
  })
})

test('malformed success JSON, absent bodies and transport failure cannot become empty successful manifests', async t => {
  for (const [label, answer] of [
    ['JSON', () => new Response('not-json')],
    ['absent body', () => new Response(null, { status: 204 })],
    ['transport', () => { throw new Error('Fixture transport failure') }],
  ] as const) await t.test(label, async t => {
    const f = fixture(t, answer)
    await assert.rejects(f.client.get(path), code('workspace_review_github_unavailable'))
    assert.equal(f.calls.length, 1)
  })
})
