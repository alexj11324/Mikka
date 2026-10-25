import assert from 'node:assert/strict'
import test from 'node:test'
import { createCoordinatorSubmitter, readOutcome } from './coordinator-submission'

type Body = { text: string; submissionId: string; questionId?: string }

// A stand-in for POST /api/coordinator/messages with the backend's rules
// (lib/coordinator-event-store.ts recordUserSubmission): one event per
// account and submissionId, 409 when the same id arrives with another body.
function fakeServer({ enabled = true } = {}) {
  const events = new Map<string, { id: string; digest: string }>()
  const requests: { owner: string | null; body: Body }[] = []
  let session: string | null = 'user-a'
  let failNext: 'drop-response' | 'network' | 500 | 409 | null = null
  async function fetch(_input: string, init: RequestInit) {
    const body: Body = JSON.parse(String(init.body))
    const owner = session
    if (failNext === 'network') { failNext = null; throw new TypeError('fetch failed') }
    requests.push({ owner, body })
    if (!owner) return Response.json({ error: 'authRequired' }, { status: 401 })
    if (failNext === 500) { failNext = null; return Response.json({}, { status: 500 }) }
    if (failNext === 409) { failNext = null; return Response.json({ error: 'submissionConflict' }, { status: 409 }) }
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
    currentOwner: async () => session,
    signIn: (owner: string | null) => { session = owner },
    fail: (kind: typeof failNext) => { failNext = kind },
    lastId: () => requests.at(-1)!.body.submissionId,
  }
}

function ids() {
  let n = 0
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
}

function setup(options?: { enabled?: boolean }) {
  const server = fakeServer(options)
  const submitter = createCoordinatorSubmitter({ currentOwner: server.currentOwner, fetch: server.fetch, newId: ids() })
  return { server, submitter }
}

// Regressions found by the backend against fc319bf with the first client and an
// in-memory fetch: in both, a plain retry went from id1 to id2.
test('regression: a plain retry after a 409 used to get id2; now it makes no request and keeps id1', async () => {
  const { server, submitter } = setup()
  server.fail(409)
  assert.deepEqual(await submitter.submit('move the meeting'), { kind: 'conflict' })
  const id1 = server.lastId()
  for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(await submitter.submit('move the meeting'), { kind: 'conflict' })
  assert.equal(server.requests.length, 1)
  assert.equal(submitter.held('user-a', 'move the meeting')?.submission.submissionId, id1)
})

test('regression: a send before the account was known used to go out under owner "" and retry as id2; now nothing is sent until it is known', async () => {
  const server = fakeServer()
  // The cookie belongs to user-a, but the account has not been resolved yet.
  let resolved = false
  const submitter = createCoordinatorSubmitter({ currentOwner: async () => resolved ? server.currentOwner() : null, fetch: server.fetch, newId: ids() })
  assert.deepEqual(await submitter.submit('book the room'), { kind: 'authRequired' })
  assert.equal(server.requests.length, 0)

  resolved = true
  server.fail('drop-response')
  assert.deepEqual(await submitter.submit('book the room'), { kind: 'uncertain' })
  const id1 = server.lastId()
  assert.deepEqual(await submitter.submit('book the room'), { kind: 'accepted', enabled: true, sourceEventId: 'event-1', replayed: true })
  assert.equal(server.lastId(), id1)
  assert.equal(server.events.size, 1)
})

test('same content: a retry of an unsettled submission keeps its id; a new submission after it settled gets a new id', async () => {
  const { server, submitter } = setup()
  server.fail(500)
  assert.deepEqual(await submitter.submit('call Sam'), { kind: 'uncertain' })
  const id1 = server.lastId()
  assert.equal((await submitter.submit('call Sam')).kind, 'accepted')
  assert.equal(server.lastId(), id1)
  // Settled: the person sending the same words again means a second message.
  assert.equal((await submitter.submit('call Sam')).kind, 'accepted')
  assert.notEqual(server.lastId(), id1)
  assert.equal(server.events.size, 2)
})

test('concurrent sends of one submission make one request and one event', async () => {
  const { server, submitter } = setup()
  const [first, second] = await Promise.all([submitter.submit(' hello '), submitter.submit('hello')])
  assert.deepEqual(first, second)
  assert.equal(server.requests.length, 1)
  assert.equal(server.events.size, 1)
})

test('a lost response is retried with the same id and body, and the server replays it', async () => {
  const { server, submitter } = setup()
  server.fail('drop-response')
  assert.deepEqual(await submitter.submit('book the room'), { kind: 'uncertain' })
  assert.deepEqual(await submitter.submit('book the room'), { kind: 'accepted', enabled: true, sourceEventId: 'event-1', replayed: true })
  assert.equal(server.events.size, 1)
  assert.deepEqual(server.requests[0].body, server.requests[1].body)
})

test('a 5xx or network failure keeps the id and body for the next send', async () => {
  const { server, submitter } = setup()
  server.fail(500)
  assert.deepEqual(await submitter.submit('hi'), { kind: 'uncertain' })
  server.fail('network')
  assert.deepEqual(await submitter.submit('hi'), { kind: 'uncertain' })
  const id = submitter.held('user-a', 'hi')?.submission.submissionId
  assert.equal((await submitter.submit('hi')).kind, 'accepted')
  assert.ok(server.requests.every(request => request.body.submissionId === id && request.body.text === 'hi'))
  assert.equal(server.events.size, 1)
})

test('once accepted, the same text sent again is a new submission with a new id', async () => {
  const { server, submitter } = setup()
  assert.equal((await submitter.submit('again')).kind, 'accepted')
  assert.equal(submitter.held('user-a', 'again'), undefined)
  assert.equal((await submitter.submit('again')).kind, 'accepted')
  assert.notEqual(server.requests[0].body.submissionId, server.requests[1].body.submissionId)
  assert.equal(server.events.size, 2)
})

test('after a 409 the body is closed: sending it again makes no request and gets no new id', async () => {
  const { server, submitter } = setup()
  server.fail(409)
  assert.deepEqual(await submitter.submit('changed'), { kind: 'conflict' })
  const id = server.lastId()
  assert.deepEqual(await submitter.submit('changed'), { kind: 'conflict' })
  assert.deepEqual(await submitter.submit('  changed  '), { kind: 'conflict' })
  assert.equal(server.requests.length, 1)
  assert.equal(submitter.held('user-a', 'changed')?.state, 'conflict')
  assert.equal(submitter.held('user-a', 'changed')?.submission.submissionId, id)
  // Only another message is a new submission.
  assert.equal((await submitter.submit('something else')).kind, 'accepted')
  assert.notEqual(server.lastId(), id)
})

test('the server answers 409 to the same id with another text or questionId', async () => {
  const server = fakeServer()
  const sameId = () => '00000000-0000-4000-8000-000000000001'
  const make = () => createCoordinatorSubmitter({ currentOwner: server.currentOwner, fetch: server.fetch, newId: sameId })
  assert.equal((await make().submit('original')).kind, 'accepted')
  assert.deepEqual(await make().submit('edited'), { kind: 'conflict' })
  assert.deepEqual(await make().submit('original', '11111111-1111-4111-8111-111111111111'), { kind: 'conflict' })
  assert.equal(server.events.size, 1)
})

test('sending an edited draft never replaces a submission that is still uncertain', async () => {
  const { server, submitter } = setup()
  server.fail('drop-response')
  assert.deepEqual(await submitter.submit('first draft'), { kind: 'uncertain' })
  const id = server.lastId()
  assert.equal((await submitter.submit('first draft, edited')).kind, 'accepted')
  assert.notEqual(server.lastId(), id)
  // The uncertain one is still held, with its own id and body.
  assert.equal(submitter.held('user-a', 'first draft')?.submission.submissionId, id)
  assert.deepEqual(await submitter.submit('first draft'), { kind: 'accepted', enabled: true, sourceEventId: 'event-1', replayed: true })
  assert.equal(server.lastId(), id)
  assert.equal(server.events.size, 2)
})

test('questionId is part of the frozen body', async () => {
  const { server, submitter } = setup()
  const question = '11111111-1111-4111-8111-111111111111'
  server.fail(500)
  assert.deepEqual(await submitter.submit('yes', question), { kind: 'uncertain' })
  const id = server.lastId()
  assert.equal((await submitter.submit('yes', question)).kind, 'accepted')
  assert.deepEqual(server.requests[1].body, { text: 'yes', submissionId: id, questionId: question })
  // The same text without the question, or for another one, is another submission.
  await submitter.submit('yes')
  assert.equal(server.requests[2].body.questionId, undefined)
  assert.notEqual(server.lastId(), id)
  await submitter.submit('yes', '22222222-2222-4222-8222-222222222222')
  assert.notEqual(server.lastId(), id)
})

test('after a 401 the same account resends the same submission; another account never does', async () => {
  const server = fakeServer()
  // The session lapses after the account check, so the request itself gets a 401.
  let lapse = true
  const currentOwner = async () => { const owner = await server.currentOwner(); if (lapse) { lapse = false; server.signIn(null) } return owner }
  const submitter = createCoordinatorSubmitter({ currentOwner, fetch: server.fetch, newId: ids() })
  assert.deepEqual(await submitter.submit('hello'), { kind: 'authRequired' })
  const id = server.lastId()
  assert.equal(submitter.held('user-a', 'hello')?.state, 'authRequired')

  server.signIn('user-b')
  assert.equal((await submitter.submit('hello')).kind, 'accepted')
  assert.equal(server.requests.at(-1)!.owner, 'user-b')
  assert.notEqual(server.lastId(), id)

  server.signIn('user-a')
  assert.equal((await submitter.submit('hello')).kind, 'accepted')
  assert.equal(server.requests.at(-1)!.owner, 'user-a')
  assert.equal(server.lastId(), id)
  assert.equal(server.events.size, 2)
})

test('no request is made while the account is unknown', async () => {
  const { server, submitter } = setup()
  server.signIn(null)
  assert.deepEqual(await submitter.submit('hello'), { kind: 'authRequired' })
  const failing = createCoordinatorSubmitter({ currentOwner: async () => { throw new Error('offline') }, fetch: server.fetch, newId: ids() })
  assert.deepEqual(await failing.submit('hello'), { kind: 'rejected', error: 'failed' })
  assert.equal(server.requests.length, 0)
})

test('enabled: false is accepted once and never resent', async () => {
  const { server, submitter } = setup({ enabled: false })
  assert.deepEqual(await submitter.submit('hello'), { kind: 'accepted', enabled: false, sourceEventId: 'event-1', replayed: false })
  assert.equal(server.requests.length, 1)
  assert.equal(submitter.held('user-a', 'hello'), undefined)
})

test('blank or too long text is refused without a request', async () => {
  const { server, submitter } = setup()
  assert.deepEqual(await submitter.submit('   '), { kind: 'rejected', error: 'messageRequired' })
  assert.deepEqual(await submitter.submit('x'.repeat(10_001)), { kind: 'rejected', error: 'messageRequired' })
  assert.equal(server.requests.length, 0)
})

test('reads server responses, including the older server without idempotency', async () => {
  assert.deepEqual(await readOutcome(Response.json({ queued: true, enabled: true }, { status: 202 })), { kind: 'accepted', enabled: true, sourceEventId: null, replayed: false })
  assert.deepEqual(await readOutcome(Response.json({ error: 'originRejected' }, { status: 403 })), { kind: 'rejected', error: 'originRejected' })
  assert.deepEqual(await readOutcome(Response.json({ error: 'messageRequired' }, { status: 400 })), { kind: 'rejected', error: 'messageRequired' })
  assert.deepEqual(await readOutcome(new Response('bad gateway', { status: 502 })), { kind: 'uncertain' })
  assert.deepEqual(await readOutcome(Response.json({ error: 'authRequired' }, { status: 401 })), { kind: 'authRequired' })
})
