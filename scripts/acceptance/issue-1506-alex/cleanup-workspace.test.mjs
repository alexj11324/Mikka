import assert from 'node:assert/strict'
import test from 'node:test'
import { ALEX_OWNER_ID } from '../issue-1506-readonly/alex-session.mjs'
import { cleanupWorkspace } from './cleanup-workspace.mjs'
import { fakeSession, fixtureReceipt, PRIVATE, WORKSPACE_ID } from './fixture-support.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }

function fixture({ impact = {}, lostAck = false, ...flags } = {}) {
  const base = fakeSession({ readyBots: true, ...flags })
  const state = { deletes: 0, deleted: false }
  const provider = (work, options) => base.provider(session => work({ ...session,
    async request(path, input = {}) {
      const route = path.split('?')[0]
      let value
      if (route === '/api/conversations') {
        assert.equal(path, '/api/conversations?workspaceId=' + WORKSPACE_ID)
        value = { viewerId: ALEX_OWNER_ID, workspaceId: WORKSPACE_ID, conversations: [] }
      } else if (route === '/api/rpc' && input.body?.action === 'workspace-settings.getWorkspaceDeletionImpact') {
        assert.deepEqual(input.body.args, [WORKSPACE_ID])
        value = { ok: true, result: { bots: 2, tasks: 0, teams: 0, purchasedPoints: 0, ...impact } }
      } else if (route === '/api/rpc' && input.body?.action === 'workspace-settings.deleteWorkspace') {
        assert.deepEqual(input.body.args, [WORKSPACE_ID, fixtureReceipt().workspace.name])
        state.deletes++; assert.equal(state.deletes, 1); state.deleted = true
        if (lostAck) throw new Error(PRIVATE)
        value = { ok: true, result: { deleted: { bots: 2, threads: 2, tasks: 0, projects: 0, teams: 0, invitations: 0, members: 1 } } }
      } else if (route === '/api/workspace/switcher' && state.deleted) {
        value = { accounts: [{ id: ALEX_OWNER_ID, email: PRIVATE,
          choices: [{ id: '4ae2a643-b09e-43eb-816c-1e5557bef170', kind: 'personal', name: PRIVATE }] }] }
      } else return session.request(path, input)
      session.requests.push({ path: '/mikka' + route, method: input.body ? 'POST' : 'GET', status: 200, headersMs: 0 })
      return Response.json(value)
    } }), options)
  return { state, base: base.state, options: { fixtureReceipt: fixtureReceipt(), sessionProvider: provider, checkpoint: false } }
}

test('final deletion requires the exact sole-owned empty-task fixture and deletes it once through the normal action', async () => {
  const f = fixture(), report = await cleanupWorkspace(f.options)
  assert.equal(report.status, 'deleted', JSON.stringify(report)); assert.equal(f.state.deletes, 1)
  assert.equal(report.absentFromOwnerWorkspaceChoices, true); assert.equal(report.signedOut, true)
  assert.equal(report.modelMessages, 0); assert.equal(f.base.sends, 0); assert.equal(f.base.stops, 0)
  assert.equal(JSON.stringify(report).includes(PRIVATE), false)
})

test('unexpected tasks, teams, purchased balance or bot counts block final deletion', async () => {
  for (const impact of [{ tasks: 1 }, { teams: 1 }, { purchasedPoints: 1 }, { bots: 3 }]) {
    const f = fixture({ impact }), report = await cleanupWorkspace(f.options)
    assert.equal(report.status, 'failed'); assert.equal(report.error, 'cleanup_impact_mismatch')
    assert.equal(f.state.deletes, 0); assert.equal(f.base.signouts, 1)
  }
})

test('foreign membership, bot ownership or active chats block workspace deletion without stopping unrelated activity', async () => {
  for (const flags of [{ extraMember: true }, { wrongBotOwner: true }, { busy: true }]) {
    const f = fixture(flags), report = await cleanupWorkspace(f.options)
    assert.equal(report.status, 'failed'); assert.equal(f.state.deletes, 0); assert.equal(f.base.stops, 0)
    assert.equal(f.base.signouts, 1)
  }
})

test('a lost deletion acknowledgement uses one authoritative absence check and never repeats the delete', async () => {
  const f = fixture({ lostAck: true }), report = await cleanupWorkspace(f.options)
  assert.equal(report.status, 'deleted', JSON.stringify(report)); assert.equal(f.state.deletes, 1)
  assert.equal(report.deleteAcknowledgement, 'absent_after_unknown_no_retry')
})
