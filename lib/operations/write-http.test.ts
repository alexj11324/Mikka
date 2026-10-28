import test from 'node:test'
import { MailboxError } from '@/lib/mailbox-error'
import assert from 'node:assert/strict'
import { approvedWriteHandler } from './write-http'
import { OperationError } from './ledger'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const proposal = { op: 'propose', action: 'send_slack_message', intentId: id, input: { channel: 'C12345678', text: 'Fixture' } }
const session = { user: { id: 'owner' }, session: { id: 'session' } }
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('https://candidate.invalid/approved-writes', {
  method: 'POST', headers: { cookie: 'synthetic=fixture', origin: 'https://candidate.invalid', ...headers }, body: JSON.stringify(body),
})

test('malformed requests fail before constructing an operation service', async () => {
  let calls = 0
  const handler = approvedWriteHandler({ api: { getSession: async () => session } }, () => { calls++; throw Error('unexpected service') })
  for (const body of [null, [], {}, { ...proposal, intentId: 'run-1' }, { ...proposal, ownerId: 'other' }, { ...proposal, input: { ...proposal.input, accountId: 'other' } }, { op: 'decide', action: proposal.action, id, approve: 'true' }]) {
    const response = await handler(request(body))
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  const malformed = new Request('https://candidate.invalid/approved-writes', { method: 'POST', headers: { cookie: 'synthetic=fixture', origin: 'https://candidate.invalid' }, body: '{' })
  assert.equal((await handler(malformed)).status, 400)
  assert.equal(calls, 0)
})

test('browser authority is checked before operation creation', async () => {
  let calls = 0
  const handler = approvedWriteHandler({ api: { getSession: async () => session } }, () => { calls++; throw Error('unexpected service') })
  assert.equal((await handler(request(proposal, { authorization: 'Bearer synthetic' }))).status, 401)
  assert.equal((await handler(request(proposal, { cookie: '' }))).status, 401)
  assert.equal((await handler(request(proposal, { origin: 'https://other.invalid' }))).status, 403)
  assert.equal((await handler(new Request('https://candidate.invalid/approved-writes'))).status, 405)
  assert.equal(calls, 0)
})

test('session and infrastructure failures are sanitized unavailable outcomes, conflicts retain their code', async () => {
  const brokenAuth = approvedWriteHandler({ api: { getSession: async () => { throw Error('private authentication diagnostic') } } }, () => { throw Error('unexpected service') })
  const unavailable = await brokenAuth(request(proposal))
  assert.equal(unavailable.status, 503)
  assert.deepEqual(await unavailable.json(), { error: 'writeServiceUnavailable' })
  for (const error of [new Error('private database diagnostic'), new OperationError('operationIntentAmbiguous'), new OperationError('operationUncertain')]) {
    const handler = approvedWriteHandler({ api: { getSession: async () => session } }, () => ({ propose: async () => { throw error }, decide: async () => { throw error }, view: async () => { throw error } }))
    for (const body of [proposal, { op: 'decide', action: proposal.action, id, approve: true }]) {
      const response = await handler(request(body))
      assert.equal(response.status, error instanceof OperationError ? 409 : 503)
      assert.deepEqual(await response.json(), { error: error instanceof OperationError ? error.message : 'writeServiceUnavailable' })
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
  }
  const absent = approvedWriteHandler({ api: { getSession: async () => null } }, () => { throw Error('unexpected service') })
  assert.equal((await absent(request(proposal))).status, 401)
})

test('session identity and durable IDs reach service; unknown stays unresolved on repeat', async () => {
  let decisions = 0, proposals = 0
  const handler = approvedWriteHandler({ api: { getSession: async ({ query }) => { assert.equal(query.disableCookieCache, true); return session } } }, action => {
    assert.equal(action, proposal.action)
    return {
      propose: async (owner, input, intentId) => { proposals++; assert.equal(owner, 'owner'); assert.equal(intentId, id); assert.deepEqual(input, proposal.input); return { status: 'awaiting_approval', actionId: id } },
      view: async () => { throw Error('unexpected view') },
      decide: async (actor, actionId, approve) => { decisions++; assert.deepEqual(actor, { userId: 'owner', sessionId: 'session' }); assert.equal(actionId, id); assert.equal(approve, true); return { status: 'running' as const, error: 'operationUncertain' } },
    }
  })
  const proposed = await handler(request(proposal))
  assert.equal(proposed.status, 200)
  assert.deepEqual(await proposed.json(), { status: 'awaiting_approval', actionId: id })
  for (let i = 0; i < 2; i++) {
    const response = await handler(request({ op: 'decide', action: proposal.action, id, approve: true }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'running', error: 'operationUncertain' })
  }
  assert.equal(proposals, 1)
  assert.equal(decisions, 2)
})

test('real HTTP envelope passes request signal/actor and preserves unconfirmed vs committed without diagnostics',async()=>{
 const req=request(proposal);let seen=false
 const service=approvedWriteHandler({api:{getSession:async()=>session}},(_action,context)=>{
  assert.equal(context?.signal,req.signal);assert.deepEqual(context?.actor,{userId:'owner',sessionId:'session'});seen=true
  return {propose:async()=>{throw new MailboxError('private database diagnostic',409,'unconfirmed')},view:async()=>{throw Error('unexpected')},decide:async()=>{throw Error('unexpected')}}
 })
 const response=await service(req);assert.equal(seen,true);assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'writeCommitUnconfirmed',commitState:'unconfirmed'})
 const committed=approvedWriteHandler({api:{getSession:async()=>session}},()=>({propose:async()=>{throw new MailboxError('private cleanup diagnostic',503,'committed')},view:async()=>{throw Error('unexpected')},decide:async()=>{throw Error('unexpected')}}))
 assert.deepEqual(await (await committed(request(proposal))).json(),{error:'writeCommitFinalizationFailed',commitState:'committed'})
})
