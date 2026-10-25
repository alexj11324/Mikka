import assert from 'node:assert/strict'
import test from 'node:test'
import { createCoordinatorSubmitter, readOutcome } from './coordinator-submission'

// A stand-in for POST /api/coordinator/messages with the backend's rules
// (lib/coordinator-event-store.ts recordUserSubmission): one event per
// account and submissionId, 409 when the same id arrives with another body.
function fakeServer({ enabled = true } = {}) {
  const events = new Map<string, { id: string; digest: string }>()
  const requests: { owner: string; body: { text: string; submissionId: string; questionId?: string } }[] = []
  let session: string | null = 'user-a'
  let failNext: 'drop-response' | 'network' | 500 | null = null
  async function fetch(_input: string, init: RequestInit) {
    const body = JSON.parse(String(init.body))
    const owner = session
    if (failNext === 'network') { failNext = null; throw new TypeError('fetch failed') }
    if (!owner) return Response.json({ error: 'authRequired' }, { status: 401 })
    requests.push({ owner, body })
    if (failNext === 500) { failNext = null; return Response.json({}, { status: 500 }) }
    const key = `${owner}:${body.submissionId}`
    const digest = JSON.stringify([body.text, body.questionId ?? null])
    const old = events.get(key)
    let response: Response
    if (old && old.digest !== digest) response = Response.json({ error: 'submissionConflict' }, { status: 409 })
    else if (old) response = Response.json({ queued: true, enabled, sourceEventId: old.id, replayed: true }, { status: 202 })
    else {
      const id = `event-${events.size + 1}`
      events.set(key, { id, digest })
      response = Response.json({ queued: true, enabled, sourceEventId: id, replayed: false }, { status: 202 })
    }
    if (failNext === 'drop-response') { failNext = null; throw new TypeError('connection reset') }
    return response
  }
  return {
    fetch, events, requests,
    signIn: (owner: string | null) => { session = owner },
    fail: (kind: typeof failNext) => { failNext = kind },
  }
}

function ids() {
  let n = 0
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
}

test('concurrent sends of one submission make one request and one event', async () => {
  const server = fakeServer()
  const submitter = createCoordinatorSubmitter({ fetch: server.fetch, newId: ids() })
  const [first, second] = await Promise.all([submitter.submit('user-a', ' hello '), submitter.submit('user-a', 'hello')])
  assert.deepEqual(first, second)
  assert.equal(server.requests.length, 1)
  assert.equal(server.events.size, 1)
})

test('a lost response is retried with the same id and body, and the server replays it', async () => {
  const server = fakeServer()
  const submitter = createCoordinatorSubmitter({ fetch: server.fetch, newId: ids() })
  server.fail('drop-response')
  assert.deepEqual(await submitter.submit('user-a', 'book the room'), { kind: 'uncertain' })
  const retried = await submitter.submit('user-a', 'book the room')
  assert.deepEqual(retried, { kind: 'accepted', enabled: true, sourceEventId: 'event-1', replayed: true })
  assert.equal(server.events.size, 1)
  assert.deepEqual(server.requests[0].body, server.requests[1].body)
})

test('a 5xx or network failure keeps the id for the next send', async () => {
  const server = fakeServer()
  const submitter = createCoordinatorSubmitter({ fetch: server.fetch, newId: ids() })
  server.fail(500)
  assert.deepEqual(await submitter.submit('user-a', 'hi'), { kind: 'uncertain' })
  server.fail('network')
  assert.deepEqual(await submitter.submit('user-a', 'hi'), { kind: 'uncertain' })
  const id = submitter.pending()?.submissionId
  assert.equal((await submitter.submit('user-a', 'hi')).kind, 'accepted')
  assert.ok(server.requests.every(request => request.body.submissionId === id))
  assert.equal(server.events.size, 1)
})

test('a conflict stops without a new id or a second request', async () => {
  let calls = 0
  const submitter = createCoordinatorSubmitter({ fetch: async () => { calls++; return Response.json({ error: 'submissionConflict' }, { status: 409 }) }, newId: ids() })
  assert.deepEqual(await submitter.submit('user-a', 'changed'), { kind: 'conflict' })
  assert.equal(calls, 1)
  assert.equal(submitter.pending(), null)
})

test('the same id with another text or questionId gets 409 from the server', async () => {
  const server = fakeServer()
  const sameId = () => '00000000-0000-4000-8000-000000000001'
  const first = createCoordinatorSubmitter({ fetch: server.fetch, newId: sameId })
  const second = createCoordinatorSubmitter({ fetch: server.fetch, newId: sameId })
  const third = createCoordinatorSubmitter({ fetch: server.fetch, newId: sameId })
  assert.equal((await first.submit('user-a', 'original')).kind, 'accepted')
  assert.deepEqual(await second.submit('user-a', 'edited'), { kind: 'conflict' })
  assert.deepEqual(await third.submit('user-a', 'original', '11111111-1111-4111-8111-111111111111'), { kind: 'conflict' })
  assert.ok(server.requests.every(request => request.body.submissionId === sameId()))
  assert.equal(server.events.size, 1)
})

test('a new submission after an accepted one gets a new id, even with the same text', async () => {
  const server = fakeServer()
  const submitter = createCoordinatorSubmitter({ fetch: server.fetch, newId: ids() })
  await submitter.submit('user-a', 'again')
  await submitter.submit('user-a', 'again')
  assert.notEqual(server.requests[0].body.submissionId, server.requests[1].body.submissionId)
  assert.equal(server.events.size, 2)
})

test('after a 401 the same account resends the same submission; another account starts anew', async () => {
  const server = fakeServer()
  const submitter = createCoordinatorSubmitter({ fetch: server.fetch, newId: ids() })
  server.signIn(null)
  assert.deepEqual(await submitter.submit('user-a', 'hello'), { kind: 'authRequired' })
  const id = submitter.pending()?.submissionId
  server.signIn('user-a')
  assert.equal((await submitter.submit('user-a', 'hello')).kind, 'accepted')
  assert.equal(server.requests[0].body.submissionId, id)

  server.signIn(null)
  await submitter.submit('user-a', 'second')
  const signedOut = submitter.pending()?.submissionId
  server.signIn('user-b')
  await submitter.submit('user-b', 'second')
  const sent = server.requests.at(-1)!
  assert.equal(sent.owner, 'user-b')
  assert.notEqual(sent.body.submissionId, signedOut)
})

test('enabled: false is accepted once and never resent', async () => {
  const server = fakeServer({ enabled: false })
  const submitter = createCoordinatorSubmitter({ fetch: server.fetch, newId: ids() })
  assert.deepEqual(await submitter.submit('user-a', 'hello'), { kind: 'accepted', enabled: false, sourceEventId: 'event-1', replayed: false })
  assert.equal(server.requests.length, 1)
  assert.equal(submitter.pending(), null)
})

test('blank or too long text is refused without a request', async () => {
  let calls = 0
  const submitter = createCoordinatorSubmitter({ fetch: async () => { calls++; return new Response(null, { status: 202 }) }, newId: ids() })
  assert.deepEqual(await submitter.submit('user-a', '   '), { kind: 'rejected', error: 'messageRequired' })
  assert.deepEqual(await submitter.submit('user-a', 'x'.repeat(10_001)), { kind: 'rejected', error: 'messageRequired' })
  assert.equal(calls, 0)
})

test('reads server responses, including the older server without idempotency', async () => {
  assert.deepEqual(await readOutcome(Response.json({ queued: true, enabled: true }, { status: 202 })), { kind: 'accepted', enabled: true, sourceEventId: null, replayed: false })
  assert.deepEqual(await readOutcome(Response.json({ error: 'originRejected' }, { status: 403 })), { kind: 'rejected', error: 'originRejected' })
  assert.deepEqual(await readOutcome(Response.json({ error: 'messageRequired' }, { status: 400 })), { kind: 'rejected', error: 'messageRequired' })
  assert.deepEqual(await readOutcome(new Response('bad gateway', { status: 502 })), { kind: 'uncertain' })
  assert.deepEqual(await readOutcome(Response.json({ error: 'authRequired' }, { status: 401 })), { kind: 'authRequired' })
})
