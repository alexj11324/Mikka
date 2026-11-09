import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createCaptureBudget, createFixtureClient, dispatch, newState } from './publication-fixture-1782.mjs'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const binding = () => ({ windowExpiresAt: new Date(Date.now() + 40 * 60000).toISOString(),
  workspaceId: id(1), botId: id(2), profileId: id(3) })
const short = b => createCaptureBudget(b, { totalMs: 500, cleanupReserveMs: 250, signoutReserveMs: 100 })
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('production budget fixes 25 minutes with independent four-minute cleanup and fifteen-second signout reserves', () => {
  const b = binding(), budget = createCaptureBudget(b)
  try {
    const proof = budget.summary()
    assert.equal(proof.totalMs, 25 * 60000); assert.equal(proof.cleanupReserveMs, 4 * 60000); assert.equal(proof.signoutReserveMs, 15000)
    assert.equal(Date.parse(proof.hardDeadline) - Date.parse(proof.workDeadline), 4 * 60000)
    assert.equal(Date.parse(proof.hardDeadline) - Date.parse(proof.cleanupDeadline), 15000)
    assert.ok(budget.remaining('work', 120000) <= 120000)
    for (const options of [{ totalMs: 26 * 60000 }, { cleanupReserveMs: 1000 }, { signoutReserveMs: 1000 },
      { totalMs: 500, cleanupReserveMs: 400, signoutReserveMs: 400 }]) assert.throws(() => createCaptureBudget(b, options), { code: 'binding_refused' })
    const expired = { ...b, windowExpiresAt: new Date(Date.now() - 1000).toISOString() }
    assert.throws(() => createCaptureBudget(expired), { code: 'budget_exhausted' })
  } finally { budget.dispose() }
  assert.equal(budget.activeTimers, 0)
})

test('real work deadline aborts an in-flight fetch and rejects later reads while cleanup and signout keep independent signals', async () => {
  const b = binding(), state = newState(), budget = short(b), calls = []
  const client = createFixtureClient(b, state, budget, async (url, init) => {
    calls.push({ path: url.pathname, signal: init.signal })
    if (calls.length === 1) return new Promise(() => {})
    return Response.json({ ok: true })
  })
  const started = performance.now()
  try {
    await assert.rejects(client.json('/api/auth/get-session'))
    assert.ok(performance.now() - started >= 150)
    assert.equal(calls[0].signal.aborted, true)
    await assert.rejects(client.json('/api/auth/get-session')); assert.equal(calls.length, 1)
    state.cleanup = true; budget.enterCleanup()
    assert.equal((await client.json('/api/auth/get-session')).ok, true)
    assert.notEqual(calls[1].signal, calls[0].signal); assert.equal(calls[1].signal.aborted, false)
    budget.enterSignout()
    assert.equal((await client.json('/api/auth/sign-out', post({}))).ok, true)
    assert.equal(calls[2].signal.aborted, false)
  } finally { client.clear(); budget.dispose() }
  assert.equal(budget.activeTimers, 0)
})

test('a stalled JSON response body is cancelled by the actual request deadline, not only its completed fetch', async () => {
  const b = binding(), budget = short(b); let cancelled = 0, calls = 0
  const client = createFixtureClient(b, newState(), budget, async () => {
    calls++
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"ok":')) }, cancel() { cancelled++ } }),
      { headers: { 'content-type': 'application/json' } })
  })
  const started = performance.now()
  try {
    await assert.rejects(client.json('/api/auth/get-session', {}, 80))
    assert.ok(performance.now() - started >= 50)
    assert.equal(cancelled, 1); assert.equal(calls, 1)
    assert.equal(budget.signal('work').aborted, false, 'the shorter request cap must not consume the reserved cleanup phase')
  } finally { client.clear(); budget.dispose() }
  assert.equal(budget.activeTimers, 0)
})

test('an exhausted cleanup request cannot consume the independent final signout reserve', async () => {
  const b = binding(), state = newState()
  const budget = createCaptureBudget(b, { totalMs: 800, cleanupReserveMs: 400, signoutReserveMs: 200 })
  const signals = []
  const client = createFixtureClient(b, state, budget, async (url, init) => {
    signals.push(init.signal)
    if (!url.pathname.endsWith('/sign-out')) return new Promise(() => {})
    return Response.json({ ok: true })
  })
  try {
    state.cleanup = true; budget.enterCleanup()
    await assert.rejects(client.json('/api/auth/get-session'))
    assert.equal(signals[0].aborted, true); assert.equal(budget.signal('cleanup').aborted, true)
    budget.enterSignout()
    assert.equal((await client.json('/api/auth/sign-out', post({}))).ok, true)
    assert.equal(signals[1].aborted, false)
  } finally { client.clear(); budget.dispose() }
  assert.equal(budget.activeTimers, 0)
})

test('dispatch deadline aborts an open NDJSON stream after one submission and preserves its uncertain result', async () => {
  const b = binding(), budget = createCaptureBudget(b, { totalMs: 2000, cleanupReserveMs: 500, signoutReserveMs: 100 })
  const state = newState(), record = { issueId: id(4), submissionId: id(5) }; state.issueId = record.issueId
  let submissions = 0, cancelled = 0
  const client = createFixtureClient(b, state, budget, async (url, init) => {
    if (url.pathname.endsWith('/api/rpc')) {
      assert.equal(JSON.parse(init.body).action, 'coordinator.sendCoordinatorMessage'); submissions++
      return Response.json({ ok: true, result: { queued: true } })
    }
    assert.ok(url.pathname.endsWith('/api/coordinator/stream'))
    const event = { type: 'tool', name: 'dispatch_run', state: 'running', call: 'fixed-call',
      input: JSON.stringify({ issueId: record.issueId }), quote: '[1782:' + record.submissionId + '] fixed' }
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n')) }, cancel() { cancelled++ } }),
      { headers: { 'content-type': 'application/x-ndjson' } })
  })
  try {
    await assert.rejects(budget.run('work', 80, signal => dispatch(client, record, b, state, 120000, signal)), { code: 'budget_exhausted' })
    await delay(0)
    assert.equal(submissions, 1); assert.equal(cancelled, 1); assert.equal(record.submitted, true)
    assert.equal(record.runId, undefined); assert.notEqual(record.dispatchSettled, true)
    assert.equal(budget.signal('cleanup').aborted, false)
  } finally { client.clear(); budget.dispose() }
  assert.equal(budget.activeTimers, 0)
})

test('late fetch completion is cancelled and cannot revive a disposed capture or admit another request', async () => {
  const b = binding(), budget = short(b); let finishFetch, cancelled = 0, calls = 0
  const client = createFixtureClient(b, newState(), budget, async () => { calls++; return new Promise(resolve => { finishFetch = resolve }) })
  const pending = client.request('/api/auth/get-session', {}, 60)
  await assert.rejects(pending)
  budget.dispose()
  finishFetch(new Response(new ReadableStream({ cancel() { cancelled++ } })))
  await delay(0)
  assert.equal(cancelled, 1)
  await assert.rejects(client.request('/api/auth/get-session')); assert.equal(calls, 1)
  client.clear(); assert.equal(budget.activeTimers, 0)
})
