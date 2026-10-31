import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashUserId, noteLogUser, requestIdFor, withRequestLog } from './request-log'

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
