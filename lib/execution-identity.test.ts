import test from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { freezeWorkerDefinition, retryWorkerDefinition } from './agent-kit/worker'
import { freezeExecutionIdentity, revalidateExecutionIdentity, rebindExecutionDevice, ExecutionIdentityError } from './execution-identity'

const resourcePolicySql = "select w.kind,l.\"organizationId\",p.\"modelCredentialSharing\",p.\"mcpSharing\",p.\"allowedModelProviders\" from mikka_workspaces w left join mikka_organization_workspaces l on l.\"workspaceId\"=w.id left join mikka_organization_resource_policies p on p.\"organizationId\"=l.\"organizationId\" where w.id=$1"
const id = (last: number) => `10000000-0000-4000-8000-${String(last).padStart(12, '0')}`
function fixture() {
  const members = new Set(['requester', 'bot-owner', 'resource-owner'])
  const state = { botOwner: 'bot-owner', workspace: id(1), deviceOwner: 'requester', keyOwner: 'requester', share: false, enabled: true, kind: 'local', revision: '1', subscription: true, e2b: true }
  const definition = freezeWorkerDefinition({ harness: 'codex', instructions: '', prompt: 'A task', parent: null, executionId: null, model: 'example-model', apiKey: { keyId: id(2), model: 'example-model' } })
  const run = { userId: 'requester', botId: id(3), deviceId: id(4), agentDefinition: definition }
  const query = { async query(sql: string, args: unknown[]) {
    let rows: unknown[] = []
    if (sql.includes('FROM mikka_workspace_members')) rows = [...members].map(userId => ({ userId }))
    else if (sql.includes('FROM bots')) rows = [{ ownerId: state.botOwner, workspaceId: state.workspace }]
    else if (sql.includes('FROM devices')) rows = [{ ownerId: state.deviceOwner, kind: state.kind, enabled: state.enabled }]
    else if (sql.includes('FROM model_api_keys')) rows = [{ ownerId: state.keyOwner, shared: state.share }]
    else if (sql.includes('FROM byos_bindings')) rows = state.subscription ? [{ ownerId: state.keyOwner, workspaceId: state.workspace, revision: state.revision, shared: state.share, modelId: 'example-model', route: 'codex_cli' }] : []
    else if (sql.includes('FROM user_e2b_keys')) rows = state.e2b ? [{ found: 1 }] : []
    else if (sql.replace(/\s+/g, ' ').trim() === resourcePolicySql) {
      assert.deepEqual(args, [state.workspace])
      // The fixture's real policy reader sees this exact non-Org Team row.
      rows = [{ kind: 'team', organizationId: null, modelCredentialSharing: null, mcpSharing: null, allowedModelProviders: null }]
    }
    else throw new Error(`Unexpected query: ${sql.slice(0, 80)} ${args}`)
    return { rows, rowCount: rows.length }
  } } as unknown as Pick<Pool, 'query'>
  const freeze = async () => definition.executionIdentity = await freezeExecutionIdentity(query, run, query)
  return { state, members, definition, run, query, freeze }
}

test('borrowing a Bot uses the requester, their own device/account, and their private output', async () => {
  const f = fixture(), identity = await f.freeze()
  assert.equal(identity.requester, 'requester')
  assert.equal(identity.botOwner, 'bot-owner')
  assert.equal(identity.executionPrincipal, 'requester')
  assert.equal(identity.outputOwner, 'requester')
  assert.equal(identity.personalResourcePolicy, 'requester_only')
  assert.equal(identity.billingAccount.model.ownerId, 'requester')
  assert.equal(identity.billingAccount.runtime.ownerId, 'requester')
  assert.equal(identity.billingAccount.model.amount, 'provider_unknown')
  assert.equal(JSON.stringify(identity).includes('ciphertext'), false)
})

test('a Bot owner cannot lend their personal device implicitly', async () => {
  const f = fixture(); f.state.deviceOwner = 'bot-owner'
  await assert.rejects(f.freeze, ExecutionIdentityError)
})

test('resource ownership is distinct from the Bot owner and explicit sharing is mandatory', async () => {
  const f = fixture(); f.state.keyOwner = 'resource-owner'
  await assert.rejects(f.freeze, ExecutionIdentityError)
  f.state.share = true
  const identity = await f.freeze()
  assert.equal(identity.billingAccount.model.ownerId, 'resource-owner')
  assert.equal(identity.resourceBindings[1].access, 'workspace_share')
  assert.equal(identity.billingAccount.runtime.ownerId, 'requester')
  f.state.share = false
  await assert.rejects(() => revalidateExecutionIdentity(f.query, f.run, f.query), ExecutionIdentityError)
})

for (const who of ['requester', 'bot-owner', 'resource-owner']) test(`revoking ${who}'s membership ends a previously valid grant`, async () => {
  const f = fixture(); f.state.keyOwner = 'resource-owner'; f.state.share = true
  await f.freeze(); f.members.delete(who)
  await assert.rejects(() => revalidateExecutionIdentity(f.query, f.run, f.query), ExecutionIdentityError)
})

test('Bot takeover and workspace migration cannot silently reassign an accepted run', async () => {
  const f = fixture(); await f.freeze(); f.state.botOwner = 'resource-owner'
  await assert.rejects(() => revalidateExecutionIdentity(f.query, f.run, f.query), ExecutionIdentityError)
  f.state.botOwner = 'bot-owner'; f.state.workspace = id(9)
  await assert.rejects(() => revalidateExecutionIdentity(f.query, f.run, f.query), ExecutionIdentityError)
})

test('subscription disconnect and revision changes revoke frozen subscription authority', async () => {
  const f = fixture(); delete f.definition.apiKey
  f.definition.subscription = { bindingId: id(8), modelId: 'example-model', route: 'codex_cli' }
  await f.freeze(); f.state.revision = '2'
  await assert.rejects(() => revalidateExecutionIdentity(f.query, f.run, f.query), ExecutionIdentityError)
  f.state.revision = '1'; f.state.subscription = false
  await assert.rejects(() => revalidateExecutionIdentity(f.query, f.run, f.query), ExecutionIdentityError)
})

test('retries retain immutable attribution and refuse an injected payment account', async () => {
  const f = fixture(); await f.freeze()
  const retry = retryWorkerDefinition(f.definition, 'Retry task')!
  retry.executionIdentity!.billingAccount.model.ownerId = 'bot-owner'
  assert.equal(f.definition.executionIdentity!.billingAccount.model.ownerId, 'requester')
  await assert.rejects(() => revalidateExecutionIdentity(f.query, { ...f.run, agentDefinition: retry }, f.query), ExecutionIdentityError)
})

test('handoff reauthorizes a same-owner destination without refreshing withdrawn shares', async () => {
  const f = fixture(); await f.freeze()
  const handoff = await rebindExecutionDevice(f.query, f.run, id(5), f.query)
  assert.equal(handoff!.executionIdentity!.resourceBindings[0].id, id(5))
  assert.equal(handoff!.executionIdentity!.requester, f.definition.executionIdentity!.requester)
  assert.equal(f.definition.executionIdentity!.resourceBindings[0].id, id(4))
  f.state.deviceOwner = 'bot-owner'
  await assert.rejects(() => rebindExecutionDevice(f.query, f.run, id(5), f.query), ExecutionIdentityError)
})

test('E2B billing remains the requester\'s own external account and deletion denies execution', async () => {
  const f = fixture(); f.state.kind = 'cloud'; const identity = await f.freeze()
  assert.deepEqual(identity.billingAccount.runtime, { kind: 'e2b', ownerId: 'requester', resourceId: 'requester', amount: 'provider_unknown' })
  f.state.e2b = false
  await assert.rejects(() => revalidateExecutionIdentity(f.query, f.run, f.query), ExecutionIdentityError)
})

test('historical runs remain unattributed instead of fabricating current owners as past payers', async () => {
  const f = fixture()
  assert.equal(await revalidateExecutionIdentity(f.query, f.run, f.query), null)
  assert.equal(f.definition.executionIdentity, undefined)
})

test('the final provider boundary rejects stopped, completed and expired executions', async () => {
  const { activeExecutionIdentity } = await import('./execution-identity')
  const f = fixture(); await f.freeze()
  const current = { ...f.run, status: 'running', stopRequestedAt: null as Date | null, leaseExpiresAt: new Date(Date.now() + 60_000) }
  const query = { async query(sql: string, args: unknown[]) {
    if (sql.includes('FROM agent_runs')) return { rows: [current] }
    return f.query.query(sql, args)
  } } as unknown as Pick<Pool, 'query'>
  assert.ok(await activeExecutionIdentity(query, id(10), 'requester', f.query))
  current.stopRequestedAt = new Date()
  await assert.rejects(() => activeExecutionIdentity(query, id(10), 'requester', f.query), ExecutionIdentityError)
  current.stopRequestedAt = null; current.status = 'succeeded'
  await assert.rejects(() => activeExecutionIdentity(query, id(10), 'requester', f.query), ExecutionIdentityError)
  current.status = 'running'; current.leaseExpiresAt = new Date(0)
  await assert.rejects(() => activeExecutionIdentity(query, id(10), 'requester', f.query), ExecutionIdentityError)
})

test('usage attributes the frozen payer and leaves external amounts unknown', async () => {
  const { executionAccountUsage } = await import('./usage/execution-accounts')
  const f = fixture(); f.state.keyOwner = 'resource-owner'; f.state.share = true
  const identity = await f.freeze()
  const rows = executionAccountUsage([{ identity, seconds: 42 }, { identity, seconds: 18 }, { identity: null, seconds: 300 }])
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.kind === 'api_key')?.ownerId, 'resource-owner')
  assert.equal(rows.find(row => row.kind === 'local_device')?.ownerId, 'requester')
  assert.equal(rows[0].runs, 2); assert.equal(rows[0].seconds, 60)
  assert.equal(rows.find(row => row.kind === 'api_key')?.amount, 'provider_unknown')
  assert.deepEqual(executionAccountUsage([{ identity: null, seconds: 10 }]), [])
})
