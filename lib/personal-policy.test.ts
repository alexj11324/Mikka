import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import type { Pool } from 'pg'

const changed = () => assert.fail('a read cannot emit an execution side effect')
for (const [path, names] of [
  ['./live/panels.ts', ['runChanged']],
  ['./live/lists.ts', ['runListChanged']],
  ['./device-gateway-notify.ts', ['runControlChanged']],
  ['./due-timer.ts', ['armDueTimerAfterCommit']],
] as const) mock.module(new URL(path, import.meta.url).href, {
  namedExports: Object.fromEntries(names.map(name => [name, changed])),
})
// Keep the real Organization policy decision in this query-boundary suite.
const resourcePolicySql = "select w.kind,l.\"organizationId\",p.\"modelCredentialSharing\",p.\"mcpSharing\",p.\"allowedModelProviders\" from mikka_workspaces w left join mikka_organization_workspaces l on l.\"workspaceId\"=w.id left join mikka_organization_resource_policies p on p.\"organizationId\"=l.\"organizationId\" where w.id=$1"
const resourceApprovalSql = 'select status from mikka_organization_resource_approvals where "organizationId"=$1 and "workspaceId"=$2 and kind=$3 and "resourceId"=$4 and "ownerId"=$5'
let organizationId: string | null = null
let sharing: 'allow' | 'approval_required' | 'deny' = 'allow'
let approval: 'approved' | 'denied' | null = null
const workspaceReads: string[] = []
beforeEach(() => { organizationId = null; sharing = 'allow'; approval = null; workspaceReads.length = 0 })
const unexpectedWorkspace = () => assert.fail('unexpected Workspace operation in share-policy fixture')
mock.module(new URL('./workspace-db.ts', import.meta.url).href, { namedExports: {
  workspaceDb: { select: unexpectedWorkspace, transaction: unexpectedWorkspace },
  workspacePool: { query: async (sql: string, values: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized === resourcePolicySql) {
      assert.deepEqual(values, ['workspace'])
      workspaceReads.push('policy')
      return { rows: [{ kind: 'team', organizationId, modelCredentialSharing: sharing, mcpSharing: 'allow', allowedModelProviders: null }], rowCount: 1 }
    }
    assert.equal(normalized, resourceApprovalSql, 'only the exact policy and approval reads are admissible')
    assert.deepEqual(values, [organizationId, 'workspace', 'subscription', 'payor', 'payor'])
    assert.ok(organizationId)
    workspaceReads.push('approval')
    return { rows: approval ? [{ status: approval }] : [], rowCount: approval ? 1 : 0 }
  } },
} })
const { othersMayUse, pooledOwners, sharedNativeBinding, setSubscriptionShare, runMayUseCredentialSql } = await import('./personal-policy')

function reader(results: { allowOthers: boolean }[][], error?: Error) {
  const calls: { sql: string; values: unknown[] }[] = []
  const query = { async query(sql: string, values: unknown[]) {
    calls.push({ sql, values })
    assert.match(sql, /^SELECT /)
    assert.deepEqual(values, ['payor', 'workspace'])
    if (error) throw error
    assert.ok(calls.length <= results.length, 'one fresh read per permission check')
    return { rows: results[calls.length - 1] }
  } } as unknown as Pick<Pool, 'query'>
  return { query, calls }
}

test("a historical allowOthers grant cannot authorize another person's subscription", async () => {
  const { query, calls } = reader([[{ allowOthers: true }]])
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
  assert.equal(calls.length, 0)
})

for (const [label, rows] of [['missing', []], ['refused', [{ allowOthers: false }]]] as const) {
  test(`a ${label} subscription share grants nothing and performs no IO`, async () => {
    const { query, calls } = reader([Array.from(rows)])
    assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
    assert.equal(calls.length, 0)
  })
}

test('legacy revoke and restore never revive cross-member subscription authority', async () => {
  const { query, calls } = reader([[{ allowOthers: true }], [{ allowOthers: false }], [{ allowOthers: true }]])
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
  assert.equal(calls.length, 0)
})

test('unavailable policy storage cannot cause a subscription sharing fail-open', async () => {
  const error = new Error('fixture_connection_failed')
  const { query, calls } = reader([], error)
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
  assert.equal(calls.length, 0)
})

test('the same local share cannot bypass a fresh Organization deny or approval decision', async () => {
  organizationId = 'organization'
  const { query, calls } = reader(Array.from({ length: 6 }, () => [{ allowOthers: true }]))
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
  sharing = 'deny'
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
  sharing = 'approval_required'
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
  approval = 'approved'
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
  approval = 'denied'
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
  sharing = 'allow'
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
  assert.equal(calls.length, 0, 'old grant rows are never admission authority')
  assert.equal(workspaceReads.length, 0, 'an Org approval cannot override provider subscription ownership')
})


test('new cross-member grants fail before writing; legacy pools and automatic bindings stay empty', async () => {
  const { query, calls } = reader([], new Error('no database IO allowed'))
  await assert.rejects(setSubscriptionShare(query, 'payor', 'workspace', true, true), { code: 'subscriptionPersonalOnly' })
  assert.deepEqual(await pooledOwners(query, 'borrower', 'workspace'), [])
  assert.equal(await sharedNativeBinding(query, 'borrower', 'agent', 'codex', 'workspace'), null)
  assert.equal(calls.length, 0)
})

test('all SQL credential gates bind the credential owner to the run actor', () => {
  const sql = runMayUseCredentialSql('credential.owner', 'run.actor', '$3')
  assert.match(sql, /credential\.owner=run\.actor/)
  assert.match(sql, /\(\$3\)::text/)
  assert.doesNotMatch(sql, /workspace_subscription_shares|allowOthers| OR /)
})
