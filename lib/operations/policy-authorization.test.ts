import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { withWritePolicy } from './policy-authorization'
import type { OperationIntent } from './ledger'

function fixture() {
 const run = randomUUID(), bot = randomUUID(), workspace = randomUUID(), id = randomUUID()
 const binding: OperationIntent = { operationId: id, ownerId: 'owner', workspaceId: 'personal:owner', provider: 'fixture', accountId: 'account', action: 'write_document', target: 'target', approvalId: id, proposalDigest: 'a'.repeat(64), payloadDigest: 'b'.repeat(64), executionRunId: run, policyScope: { botId: bot, workspaceId: workspace, version: '1' } }
 const state = { choice: 'allow', version: '1', bindingChecks: 0, approvals: 0, approved: false }
 const tx = { query: async (sql: string) => sql.includes('agent_kit_heads') ? { rows: [{ workspace_id: workspace, external_write_permissions: { write_document: state.choice }, external_write_policy_version: state.version }] } : { rows: [{ status: 'running', snapshot: { effectiveTools: ['write_document'] } }] } } as unknown as Parameters<ReturnType<typeof withWritePolicy>>[0]
 const authorize = withWritePolicy(async (_tx, b) => { state.bindingChecks++; if (b.accountId !== 'account' || b.target !== 'target') throw Error('binding changed') }, async () => { state.approvals++; if (!state.approved) throw Error('approval required') })
 return { run, binding, state, tx, authorize }
}
test('allow needs no review; ask checks existing approval; deny never approves', async () => {
 const f = fixture()
 await f.authorize(f.tx, f.binding, f.run, 'invoke'); assert.equal(f.state.approvals, 0)
 f.state.choice = 'ask'; await assert.rejects(f.authorize(f.tx, f.binding, f.run, 'invoke'), /approval required/)
 f.state.approved = true; await f.authorize(f.tx, f.binding, f.run, 'invoke'); assert.equal(f.state.approvals, 2)
 f.state.choice = 'deny'; await assert.rejects(f.authorize(f.tx, f.binding, f.run, 'invoke'), /writeDenied/); assert.equal(f.state.approvals, 2)
})
test('revocation, changed binding and wrong run cannot pass invocation', async () => {
 const f = fixture(); f.state.version = '2'
 await assert.rejects(f.authorize(f.tx, f.binding, f.run, 'invoke'), /writePolicyChanged/)
 f.state.version = '1'
 await assert.rejects(f.authorize(f.tx, { ...f.binding, accountId: 'other' }, f.run, 'invoke'), /binding changed/)
 await assert.rejects(f.authorize(f.tx, f.binding, randomUUID(), 'invoke'), /writePolicyUnavailable/)
})
