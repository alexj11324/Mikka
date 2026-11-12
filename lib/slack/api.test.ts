import assert from 'node:assert/strict'
import { test } from 'node:test'
import { postSlackCompletion, type SlackCompletionPost, type SlackPostResult } from './api'
import { slackConfig } from './config'

const TOKEN = 'xoxb-test-only-secret-token'
const config = slackConfig({
  SLACK_BOT_TOKEN: TOKEN,
  SLACK_SIGNING_SECRET: 'test-only-signing-secret',
  SLACK_APP_ID: 'A123',
  SLACK_TEAM_ID: 'T123',
  SLACK_BOT_USER_ID: 'U123',
  SLACK_USER_BINDINGS: JSON.stringify({ U456: 'owner-a' }),
})!
const post: SlackCompletionPost = {
  channel: 'C123',
  threadTs: '1700000000.000100',
  text: 'Mikka: MIK-42 Fix login redirect — Done\nhttps://app.example.com/mikka/?issue=1&thread=2',
  runId: 'run-1',
  linkId: 'link-1',
}

interface Seen {
  url: string
  init: RequestInit
}

function fakeFetch(reply: () => Promise<Response>) {
  const seen: Seen[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      init: init ?? {},
    })
    return reply()
  }
  return { fetch: fetchImpl, seen }
}

const slackResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

test('one chat.postMessage call carries the text, metadata and no unfurls', async () => {
  const { fetch, seen } = fakeFetch(async () => slackResponse({ ok: true, ts: '1700000000.000200' }))
  const result = await postSlackCompletion(config, post, { fetch })
  assert.deepEqual(result, { status: 'ok', ts: '1700000000.000200' })
  assert.equal(seen.length, 1)
  const { url, init } = seen[0]
  assert.equal(url, 'https://slack.com/api/chat.postMessage')
  assert.equal(init.method, 'POST')
  const headers = new Headers(init.headers)
  assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`)
  assert.equal(headers.get('content-type'), 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(String(init.body)), {
    channel: post.channel,
    thread_ts: post.threadTs,
    text: post.text,
    metadata: {
      event_type: 'mikka_run_finished',
      event_payload: { runId: post.runId, linkId: post.linkId },
    },
    unfurl_links: false,
    unfurl_media: false,
  })
  assert.ok(init.signal instanceof AbortSignal)
  assert.equal(JSON.stringify(result).includes(TOKEN), false, 'the token never reaches the result')
})

test('Slack error codes become skipped, failed or retryable with no raw text', async () => {
  const cases: Array<[string, Response, SlackPostResult]> = [
    ['channel_not_found', slackResponse({ ok: false, error: 'channel_not_found' }), { status: 'skipped', code: 'channel_not_found' }],
    ['is_archived', slackResponse({ ok: false, error: 'is_archived' }), { status: 'skipped', code: 'is_archived' }],
    ['channel_is_archived', slackResponse({ ok: false, error: 'channel_is_archived' }), { status: 'skipped', code: 'channel_is_archived' }],
    ['not_in_channel', slackResponse({ ok: false, error: 'not_in_channel' }), { status: 'skipped', code: 'not_in_channel' }],
    ['invalid_auth', slackResponse({ ok: false, error: 'invalid_auth' }), { status: 'failed', code: 'invalid_auth' }],
    ['token_revoked', slackResponse({ ok: false, error: 'token_revoked' }), { status: 'failed', code: 'token_revoked' }],
    ['account_inactive', slackResponse({ ok: false, error: 'account_inactive' }), { status: 'failed', code: 'account_inactive' }],
    ['unknown code', slackResponse({ ok: false, error: 'something_new' }), { status: 'failed', code: 'unknown' }],
    ['server error', slackResponse({ ok: false, error: 'fatal_error' }, 503), { status: 'retryable', reason: 'server_error' }],
    ['ok without ts', slackResponse({ ok: true }), { status: 'failed', code: 'invalid_response' }],
  ]
  for (const [name, response, expected] of cases) {
    const { fetch } = fakeFetch(async () => response.clone())
    assert.deepEqual(await postSlackCompletion(config, post, { fetch }), expected, name)
  }
})

test('HTTP 429 reads Retry-After seconds and caps the wait at one minute', async () => {
  const cases: Array<[string | null, number]> = [
    ['7', 7_000],
    ['999', 60_000],
    [null, 1_000],
    ['not-a-number', 1_000],
    ['-1', 1_000],
    ['0', 0],
  ]
  for (const [header, expected] of cases) {
    const headers: Record<string, string> = header === null ? {} : { 'retry-after': header }
    const { fetch } = fakeFetch(async () => slackResponse({ ok: false, error: 'ratelimited' }, 429, headers))
    assert.deepEqual(
      await postSlackCompletion(config, post, { fetch }),
      { status: 'retryable', reason: 'rate_limited', retryAfterMs: expected },
      String(header),
    )
  }
  const { fetch } = fakeFetch(async () => slackResponse({ ok: false, error: 'ratelimited' }, 200, { 'retry-after': '3' }))
  assert.deepEqual(
    await postSlackCompletion(config, post, { fetch }),
    { status: 'retryable', reason: 'rate_limited', retryAfterMs: 3_000 },
    'a 200 ratelimited body still waits',
  )
})

test('a timeout is retryable and the abort reason never reaches the caller', async () => {
  for (const error of [new DOMException('timed out', 'TimeoutError'), new DOMException('aborted', 'AbortError')]) {
    const { fetch } = fakeFetch(async () => { throw error })
    assert.deepEqual(await postSlackCompletion(config, post, { fetch }), { status: 'retryable', reason: 'timeout' })
  }
  const waiting: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')))
  })
  assert.deepEqual(await postSlackCompletion(config, post, { fetch: waiting, timeoutMs: 10 }), { status: 'retryable', reason: 'timeout' })
})

test('a network failure never echoes the token or the underlying message, and logs nothing', async () => {
  const calls: unknown[][] = []
  const target = console as unknown as Record<string, (...args: unknown[]) => void>
  const saved = { warn: target.warn, error: target.error }
  target.warn = (...args) => { calls.push(args) }
  target.error = (...args) => { calls.push(args) }
  let result: SlackPostResult | undefined
  try {
    const { fetch } = fakeFetch(async () => { throw new Error(`connect failed with ${TOKEN}`) })
    result = await postSlackCompletion(config, post, { fetch })
  } finally {
    target.warn = saved.warn
    target.error = saved.error
  }
  assert.ok(result)
  assert.deepEqual(result, { status: 'retryable', reason: 'network' })
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
  assert.equal(JSON.stringify(result).includes('connect failed'), false)
  assert.deepEqual(calls, [])
})

test('a 200 response that is not JSON degrades to a fixed failed code', async () => {
  const { fetch } = fakeFetch(async () => new Response('not json', { status: 200 }))
  assert.deepEqual(await postSlackCompletion(config, post, { fetch }), { status: 'failed', code: 'unknown' })
})
