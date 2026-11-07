import { test } from 'node:test'
import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import { hashUserId, noteLogOutcome, noteLogUser, requestIdFor, withRequestLog } from './request-log'

function capture() {
  const lines: Array<{ line: string; level: string }> = []
  return { lines, sink: (line: string, level: string) => { lines.push({ line, level }) } }
}

test('logs paired start/completion lines with safe fields only', async () => {
  const { lines, sink } = capture()
  const handler = withRequestLog('/api/demo', async () => {
    noteLogUser('user-123')
    return new Response('ok', { status: 201 })
  }, sink)
  const res = await handler(new Request('https://x.test/api/demo?token=SECRET&email=a@b.c', {
    headers: { 'x-vercel-id': 'iad1::abc-123', cookie: 'session=SECRET', authorization: 'Bearer SECRET' },
  }))
  assert.equal(res.status, 201)
  assert.equal(lines.length, 2)
  const start = JSON.parse(lines[0].line)
  assert.equal(start.msg, 'api_request_started')
  const entry = JSON.parse(lines.at(-1)!.line)
  assert.deepEqual(Object.keys(entry).sort(), ['durationMs', 'invocationId', 'level', 'method', 'msg', 'requestId', 'route', 'status', 'timestamp', 'userIdHash'])
  assert.equal(start.invocationId, entry.invocationId)
  assert.match(entry.timestamp, /^\d{4}-/)
  assert.equal(entry.requestId, 'iad1::abc-123')
  assert.equal(entry.route, '/api/demo')
  assert.equal(entry.userIdHash, hashUserId('user-123'))
  assert.match(entry.userIdHash, /^[0-9a-f]{16}$/)
  assert.ok(!lines.some(item => item.line.includes('SECRET')))
  assert.ok(!lines.some(item => item.line.includes('a@b.c')))
  assert.ok(!lines.some(item => item.line.includes('user-123')))
})

test('4xx is warn, 5xx is error, anonymous has null user', async () => {
  const { lines, sink } = capture()
  await withRequestLog('/api/a', () => new Response(null, { status: 404 }), sink)(new Request('https://x.test/api/a'))
  await withRequestLog('/api/b', () => new Response(null, { status: 503 }), sink)(new Request('https://x.test/api/b'))
  assert.deepEqual(lines.map((l) => l.level), ['info', 'warn', 'info', 'error'])
  assert.equal(JSON.parse(lines.at(-1)!.line).userIdHash, null)
})

test('thrown errors log status 500 with the error name only and rethrow', async () => {
  const { lines, sink } = capture()
  const handler = withRequestLog('/api/boom', () => { throw new TypeError('leaked secret abc') }, sink)
  await assert.rejects(handler(new Request('https://x.test/api/boom', { method: 'POST' })), TypeError)
  const entry = JSON.parse(lines.at(-1)!.line)
  assert.equal(entry.status, 500)
  assert.equal(entry.error, 'TypeError')
  assert.ok(!lines.some(item => item.line.includes('leaked')))
})

test('generates a request id when x-vercel-id is missing or malformed', () => {
  assert.match(requestIdFor(new Request('https://x.test/')), /^[0-9a-f-]{36}$/)
  assert.match(requestIdFor(new Request('https://x.test/', { headers: { 'x-vercel-id': 'bad value\n' } })), /^[0-9a-f-]{36}$/)
})

test('a failing sink never breaks the request', async () => {
  const res = await withRequestLog('/api/x', () => new Response('ok'), () => { throw new Error('sink') })(new Request('https://x.test/api/x'))
  assert.equal(res.status, 200)
})

test('outcomes allow only fixed values and stay isolated between concurrent requests', async () => {
  const { lines, sink } = capture()
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const empty = withRequestLog('/api/empty', async () => { noteLogOutcome('empty'); await waiting; return new Response(null) }, sink)
  const work = withRequestLog('/api/work', async () => { noteLogOutcome('work'); release(); return new Response(null) }, sink)
  noteLogOutcome('ignored')
  await Promise.all([empty(new Request('https://x.test/empty')), work(new Request('https://x.test/work'))])
  await withRequestLog('/api/invalid', () => {
    noteLogOutcome('SECRET' as 'empty')
    return new Response(null)
  }, sink)(new Request('https://x.test/invalid'))
  const completed = lines.map(item => JSON.parse(item.line)).filter(entry => entry.msg === 'api_request')
  assert.deepEqual(Object.fromEntries(completed.map(entry => [entry.route, entry.outcome])), { '/api/empty': 'empty', '/api/work': 'work', '/api/invalid': undefined })
  assert.ok(!lines.some(item => item.line.includes('SECRET')))
  assert.ok(lines.filter(item => JSON.parse(item.line).msg === 'api_request_started').every(item => !('outcome' in JSON.parse(item.line))))
})

test('request attribution publishes an internal invocation ID before auth and caches each authenticated identity', async () => {
  const metadata = channel('mikka.request.metadata')
  const updates: Array<Record<string, unknown>> = []
  const observe = (value: unknown) => { updates.push({ ...(value as Record<string, unknown>) }) }
  const originalSalt = process.env.LOG_HASH_SALT
  metadata.subscribe(observe)
  const { lines, sink } = capture()
  try {
    process.env.LOG_HASH_SALT = 'fixture-first'
    const firstHash = hashUserId('private-user-a')
    await withRequestLog('/api/demo', () => {
      assert.equal(updates.length, 1)
      assert.match(String(updates[0].requestId), /^[0-9a-f-]{36}$/)
      assert.deepEqual(Object.keys(updates[0]), ['requestId'])
      noteLogUser('private-user-a')
      process.env.LOG_HASH_SALT = 'fixture-changed'
      noteLogUser('private-user-a')
      noteLogUser(null)
      return new Response('ok')
    }, sink)(new Request('https://x.test/api/demo?private=PRIVATE_QUERY', {
      headers: { 'x-vercel-id': 'external-edge-id', authorization: 'Bearer PRIVATE_TOKEN' },
    }))
    const first = JSON.parse(lines[1].line)
    assert.equal(first.invocationId, updates[0].requestId)
    assert.notEqual(first.invocationId, first.requestId)
    assert.equal(first.userIdHash, firstHash)
    assert.deepEqual(updates[1], { requestId: first.invocationId, userIdHash: firstHash })
    assert.equal(updates.length, 2)

    await withRequestLog('/api/demo', () => {
      noteLogUser('private-user-a')
      noteLogUser('private-user-b')
      noteLogUser('private-user-b')
      return new Response('ok')
    }, sink)(new Request('https://x.test/api/demo', { headers: { 'x-vercel-id': 'external-edge-id' } }))
    const second = JSON.parse(lines[3].line)
    assert.notEqual(second.invocationId, first.invocationId)
    assert.equal(second.userIdHash, hashUserId('private-user-b'))
    assert.equal(updates.length, 5)
    assert.equal(updates[4].userIdHash, second.userIdHash)
    assert.doesNotMatch(JSON.stringify({ updates, lines }), /private-user-|PRIVATE_QUERY|PRIVATE_TOKEN/)
  } finally {
    metadata.unsubscribe(observe)
    if (originalSalt === undefined) delete process.env.LOG_HASH_SALT
    else process.env.LOG_HASH_SALT = originalSalt
  }
})
