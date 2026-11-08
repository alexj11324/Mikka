import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import type { RequestBudget } from '../../request-budget'
import { GitHubDiffClient, GitHubWriteRejection } from './github-api'

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

const reviewPath = '/repos/fixture/review/pulls/7/reviews'
const readDocument = 'query WorkspaceRead($text:String) { viewer { login } }'

test('GraphQL reads use the same fixed authenticated origin and encode variables as data', async t => {
  const variables = { text: '} mutation Forged { deleteRepository }', after: 'opaque/provider/cursor' }
  const f = fixture(t, (url, init) => {
    assert.equal(url.href, 'https://api.github.com/graphql'); assert.equal(init.method, 'POST')
    assert.equal(new Headers(init.headers).get('content-type'), 'application/json')
    assert.deepEqual(JSON.parse(String(init.body)), { query: readDocument, variables })
    return Response.json({ data: { viewer: { login: 'fixture' } }, errors: [] }, {
      headers: { link: '<https://outside.invalid/graphql>; rel="next"' },
    })
  })
  assert.deepEqual(await f.client.graphql(readDocument, variables), { viewer: { login: 'fixture' } })
  assert.equal(f.calls.length, 1)
})

test('GraphQL admits explicit read queries only and rejects mutations before fetch', async t => {
  const f = fixture(t, () => Response.json({ data: {} }))
  for (const query of ['', '{ viewer { login } }', 'mutation Review { addPullRequestReview }',
    'subscription Changed { viewer { login } }', 'query Read { viewer { login } } mutation Write { addPullRequestReview }'])
    await assert.rejects(() => f.client.graphql(query, {}), code('workspace_invalid_request'))
  assert.equal(f.calls.length, 0)
})

test('HTTP 200 GraphQL failures reject partial data and redact provider details', async t => {
  for (const [label, errors, expected] of [
    ['forbidden', [{ type: 'FORBIDDEN', message: token }], 'workspace_review_github_forbidden'],
    ['not found', [{ type: 'NOT_FOUND', message: token }], 'workspace_review_github_forbidden'],
    ['unauthorized', [{ type: 'UNAUTHORIZED', message: token }], 'workspace_review_github_forbidden'],
    ['other failure', [{ type: 'INTERNAL', message: token }], 'workspace_review_github_unavailable'],
    ['untyped failure', [{ message: token }], 'workspace_review_github_unavailable'],
    ['invalid object', { message: token }, 'workspace_review_github_unavailable'],
    ['invalid null', null, 'workspace_review_github_unavailable'],
  ] as const) await t.test(label, async t => {
    const f = fixture(t, () => Response.json({ data: { privatePartial: token }, errors }))
    await assert.rejects(() => f.client.graphql(readDocument, {}), error => {
      assert.ok(code(expected)(error)); assert.ok(!String(error).includes(token)); return true
    })
    assert.equal(f.calls.length, 1)
  })
  for (const response of [{}, { data: null }, [], null]) await t.test(`missing data ${JSON.stringify(response)}`, async t => {
    const f = fixture(t, () => Response.json(response))
    await assert.rejects(() => f.client.graphql(readDocument, {}), code('workspace_review_github_unavailable'))
  })
})

test('provider POST accepts only review creation and replies with exact decimal comment IDs', async t => {
  const replyPath = '/repos/fixture/review/pulls/7/comments/9007199254740993/replies'
  const f = fixture(t, (_url, init) => {
    assert.equal(init.method, 'POST'); assert.equal(new Headers(init.headers).get('content-type'), 'application/json')
    return Response.json({ id: '9007199254740994' })
  })
  const review = { commit_id: 'a'.repeat(40), event: 'COMMENT', body: 'Explicitly requested review', comments: [] }
  const reply = { body: 'Explicitly requested reply' }
  assert.deepEqual(await f.client.post(reviewPath, review), { id: '9007199254740994' })
  assert.deepEqual(await f.client.post(replyPath, reply), { id: '9007199254740994' })
  assert.deepEqual(f.calls.map(call => call.url.pathname), [reviewPath, replyPath])
  assert.deepEqual(f.calls.map(call => JSON.parse(String(call.init.body))), [review, reply])
})

test('provider POST refuses other operations, external URLs, redirects and path ambiguity', async t => {
  const f = fixture(t, () => Response.json({}))
  for (const invalid of ['https://api.github.com' + reviewPath, '//outside.invalid/reviews', '/graphql',
    '/repos/fixture/review/issues/7/comments', '/repos/fixture/review/pulls/7/comments',
    '/repos/fixture/review/pulls/7/reviews/1/events', '/repos/fixture/review/pulls/7/reviews/1',
    '/repos/fixture/review/pulls/0/reviews', '/repos/fixture/review/pulls/-1/reviews',
    '/repos/fixture/review/pulls/7/comments/0/replies', '/repos/fixture/review/pulls/7/comments/1/replies?extra=1',
    reviewPath + '?token=outside', reviewPath + '#fragment', reviewPath + '/',
    '/repos/fixture/../pulls/7/reviews', '/repos/fixture/%2e%2e/pulls/7/reviews',
    '/repos/fixture/review\\outside/pulls/7/reviews'])
    await assert.rejects(() => f.client.post(invalid, {}), error => code('workspace_invalid_request')(error) || code('workspace_limit_exceeded')(error))
  assert.equal(f.calls.length, 0)
  const redirect = fixture(t, () => new Response('{}', { status: 307, headers: { location: 'https://outside.invalid/write' } }))
  await assert.rejects(() => redirect.client.post(reviewPath, {}), code('workspace_review_github_unavailable'))
  assert.equal(redirect.calls.length, 1)
})

test('GraphQL and provider POST enforce 128 KiB of serialized UTF-8 bytes before sending', async t => {
  for (const kind of ['graphql', 'review'] as const) await t.test(kind, async t => {
    const f = fixture(t, () => Response.json({ data: { accepted: true }, id: '123' }))
    const request = (text: string) => kind === 'graphql' ? f.client.graphql(readDocument, { text }) : f.client.post(reviewPath, { body: text })
    const payload = kind === 'graphql' ? { query: readDocument, variables: { text: '' } } : { body: '' }
    const available = 128 * 1024 - Buffer.byteLength(JSON.stringify(payload))
    await request('x'.repeat(available))
    assert.equal(Buffer.byteLength(String(f.calls[0]!.init.body)), 128 * 1024)
    await assert.rejects(() => request('x'.repeat(available + 1)), code('workspace_limit_exceeded'))
    await assert.rejects(() => request('界'.repeat(Math.floor(available / 3) + 1)), code('workspace_limit_exceeded'))
    assert.equal(f.calls.length, 1, 'oversized bodies never reach fetch, including multibyte strings')
  })
})

test('GraphQL and provider POST retain their own bounded response readers', async t => {
  for (const [kind, cap] of [['graphql', 4 * 1024 * 1024], ['review', 1024 * 1024]] as const) await t.test(kind, async t => {
    const stream = streamed(Buffer.alloc(cap + 1, 32)), f = fixture(t, () => stream.response)
    await assert.rejects(() => kind === 'graphql' ? f.client.graphql(readDocument, {}) : f.client.post(reviewPath, {}), code('workspace_limit_exceeded'))
    assert.equal(stream.cancelled(), 1); assert.equal(f.calls.length, 1)
  })
})

test('a failed POST is never automatically retried and missing response headers cannot prove rejection', async t => {
  for (const [label, answer, expected] of [
    ['transport failure', () => { throw new Error(token) }, 'workspace_review_github_unavailable'],
    ['timeout', () => { throw new DOMException(token, 'TimeoutError') }, 'workspace_review_github_unavailable'],
    ['malformed response', () => new Response('accepted but lost JSON ' + token), 'workspace_review_github_unavailable'],
    ['403', () => Response.json({ message: token }, { status: 403 }), 'workspace_review_github_forbidden'],
    ['409', () => Response.json({ message: token }, { status: 409 }), 'workspace_snapshot_outdated'],
    ['422', () => Response.json({ message: token }, { status: 422 }), 'workspace_review_github_unavailable'],
    ['503', () => Response.json({ message: token }, { status: 503 }), 'workspace_review_github_unavailable'],
  ] as const) await t.test(label, async t => {
    const f = fixture(t, answer)
    await assert.rejects(() => f.client.post(reviewPath, { body: 'One invocation' }), error => {
      assert.ok(code(expected)(error)); assert.ok(!String(error).includes(token))
      assert.equal(error instanceof GitHubWriteRejection, ['403', '409', '422'].includes(label))
      return true
    })
    assert.equal(f.calls.length, 1)
  })
})

test('a self-review 422 proves a refused mutation, while the same failed read cannot prove a refused write', async t => {
  const message = 'Can not request changes on your own pull request'
  const response = { message: 'Validation Failed', errors: [{ resource: 'PullRequestReview', code: 'custom', message }],
    documentation_url: 'https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request', status: '422' }
  const review = { commit_id: 'a'.repeat(40), event: 'REQUEST_CHANGES', body: 'Please fix this task.', comments: [] }
  for (const kind of ['mutation', 'GET', 'GraphQL'] as const) await t.test(kind, async t => {
    const f = fixture(t, () => Response.json(response, { status: 422 }))
    await assert.rejects(() => kind === 'mutation' ? f.client.post(reviewPath, review)
      : kind === 'GET' ? f.client.get(reviewPath) : f.client.graphql(readDocument, {}), error => {
      assert.ok(code('workspace_review_github_unavailable')(error))
      assert.equal(error instanceof GitHubWriteRejection, kind === 'mutation')
      assert.ok(error instanceof WorkspaceReviewError)
      assert.equal(error.cause, undefined, 'provider validation details and credential-bearing transport objects stay private')
      assert.ok(!String(error).includes(message)); assert.ok(!JSON.stringify(error).includes(message))
      return true
    })
    assert.equal(f.calls.length, 1, 'a definitive refusal does not retry or change the requested review event')
    if (kind === 'mutation') assert.deepEqual(JSON.parse(String(f.calls[0]!.init.body)), review)
  })
})

test('a mutation 422 remains a definitive refusal without reading missing, broken or untrusted error bodies', async t => {
  for (const kind of ['absent', 'broken', 'oversized', 'poison text'] as const) await t.test(kind, async t => {
    let pulls = 0, cancelled = 0
    const bytes = kind === 'oversized' ? Buffer.alloc(64 * 1024 + 1, 32)
      : Buffer.from(JSON.stringify({ message: `rate limit / abuse detection / ${token}`, errors: [{ message: token }] }))
    const response = kind === 'absent' ? new Response(null, { status: 422 })
      : kind === 'broken' ? new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error(token)) },
      }), { status: 422 })
      : new Response(new ReadableStream<Uint8Array>({
        pull(controller) { pulls++; controller.enqueue(bytes); controller.close() },
        cancel() { cancelled++ },
      }, { highWaterMark: 0 }), { status: 422 })
    const f = fixture(t, () => response)
    await assert.rejects(() => f.client.post(reviewPath, { event: 'REQUEST_CHANGES', body: 'One invocation' }), error => {
      assert.ok(error instanceof GitHubWriteRejection)
      assert.equal(error.code, 'workspace_review_github_unavailable'); assert.equal(error.cause, undefined)
      assert.ok(!String(error).includes(token)); assert.ok(!JSON.stringify(error).includes(token))
      return true
    })
    assert.equal(f.calls.length, 1)
    if (kind === 'oversized' || kind === 'poison text') {
      assert.equal(pulls, 0, 'the status proves refusal before any error-body bytes are consumed')
      assert.equal(cancelled, 1, 'discard the unused response body')
    }
  })
})

test('a mutation 422 carrying explicit rate-limit headers does not prove definitive rejection', async t => {
  for (const [name, value] of [['retry-after', '60'], ['x-ratelimit-remaining', '0']] as const)
    await t.test(name, async t => {
      const f = fixture(t, () => Response.json({ message: 'Validation Failed', privateDetail: token }, { status: 422, headers: { [name]: value } }))
      await assert.rejects(() => f.client.post(reviewPath, { event: 'REQUEST_CHANGES', body: 'One invocation' }), error => {
        assert.ok(code('workspace_review_github_unavailable')(error))
        assert.equal(error instanceof GitHubWriteRejection, false)
        assert.ok(!String(error).includes(token)); assert.ok(!JSON.stringify(error).includes(token))
        return true
      })
      assert.equal(f.calls.length, 1)
    })
})

test('GET, GraphQL and provider POST share one aggregate invocation budget', async t => {
  const f = fixture(t, () => Response.json({ data: { accepted: true }, id: '123' }))
  for (let index = 0; index < 16; index++) {
    await f.client.get(path); await f.client.graphql(readDocument, {}); await f.client.post(reviewPath, {})
  }
  assert.equal(f.calls.length, 48)
  await assert.rejects(() => f.client.graphql(readDocument, {}), code('workspace_limit_exceeded'))
  assert.equal(f.calls.length, 48)
})
