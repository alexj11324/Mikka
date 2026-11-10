import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { enterprisePrincipal, type EnterprisePrincipal } from '../enterprise/principal'
import { tokenWorkspace } from '../tokens/principal'
import { ActionFailureError } from '../action-error'
import { createInboxGuard } from './workspace'
import { InboxStore } from './store'
import { handleInbox } from './http'

test('inbox reads and commands preserve the original session and machine provenance through canonical admission', async () => {
  const workspaceId = randomUUID(), url = 'https://app.invalid/api/inbox'
  const noDatabase = new Proxy({}, { get() { assert.fail('canonical refusal must happen before reading or writing inbox data') } }) as never
  const principals: EnterprisePrincipal[] = [
    { kind: 'session', sessionId: 'session-fixture' },
    { kind: 'pat', tokenId: 'pat-fixture', workspaceId },
    { kind: 'delegation', credentialId: 'delegated-fixture', credentialKind: 'oauth', workspaceId },
  ]
  for (const principal of principals) {
    const user = { id: 'owner', [enterprisePrincipal]: principal, ...(principal.kind === 'session' ? {} : { [tokenWorkspace]: workspaceId }) }
    let admissions = 0
    const guard = createInboxGuard(async (reader, selected) => {
      assert.equal(reader, user, 'the authenticated reader must not be reduced to an owner id or reconstructed from request input')
      assert.equal(selected, workspaceId)
      admissions++
      throw new ActionFailureError('workspaceAccessDenied')
    })
    const store = new InboxStore(noDatabase, guard, noDatabase, noDatabase)
    const read = await handleInbox(new Request(`${url}?workspaceId=${workspaceId}`), user, store)
    assert.equal(read.status, 403)
    assert.deepEqual(await read.json(), { error: 'workspaceAccessDenied' })
    const write = await handleInbox(new Request(url, { method: 'POST', headers: { origin: 'https://app.invalid' },
      body: JSON.stringify({ workspaceId, type: 'task', id: randomUUID(), action: 'reopen' }) }), user, store)
    assert.equal(write.status, 403)
    assert.equal(admissions, 2, 'each operation rechecks its original proof')
    const other = await handleInbox(new Request(`${url}?workspaceId=${randomUUID()}`), { ...user, [tokenWorkspace]: workspaceId }, store)
    assert.equal(other.status, 403)
    assert.equal(admissions, 2, 'a pinned token cannot ask the admission boundary for another tenant')
  }
})

test('inbox admission does not disguise infrastructure errors or release the lease before source work ends', async () => {
  const original = new Error('database fixture unavailable'), workspaceId = randomUUID()
  const refused = createInboxGuard(async () => { throw original })
  await assert.rejects(refused('owner', workspaceId, async () => true), error => error === original)
  let held = false
  const guard = createInboxGuard(async (_reader, id, work) => {
    held = true
    try { return await work({ id, kind: 'team' }, undefined as never) } finally { held = false }
  })
  assert.equal(await guard('owner', workspaceId, async scope => { await Promise.resolve(); assert.equal(held, true); assert.equal(scope.personal, false); return 'committed' }), 'committed')
  assert.equal(held, false)
})
