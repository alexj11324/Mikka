import './credential-diagnostics-offline.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import { SCOPE_DATABASES, SCOPE_RETAINED_DATABASE, SCOPE_RETIRED_APPROVALS, scopePolicy, scopeUrl } from './scope-acceptance-policy.mjs'
import { verifyFreshScopeTargets, verifyFreshScopePreflight, scopeExecutionMode } from './scope-acceptance.mjs'
import { scopeNativeRuntime } from './scope-acceptance-runtime.mjs'

const manifest = () => ({
  mode: 'fresh-exclusive-scope', retiredApprovalIds: [...SCOPE_RETIRED_APPROVALS], databases: Object.values(SCOPE_DATABASES), approvalTransfer: false,
  preservedDatabase: { name: SCOPE_RETAINED_DATABASE, oid: '65537', owner: 'postgres', businessSqlAuthorized: false },
})
const retained = () => [{ datname: SCOPE_RETAINED_DATABASE, oid: '65537', owner: 'postgres' }]

test('fresh manifest binds exactly three fixed targets and the separate non-writable retained identity', () => {
  verifyFreshScopeTargets(manifest())
  const mutations = [
    m => { m.databases[0] = SCOPE_RETAINED_DATABASE },
    m => { m.databases[0] = 'arbitrary_replacement' },
    m => { m.databases[1] = m.databases[0] },
    m => { m.databases.reverse() },
    m => { m.preservedDatabase.oid = 'other' },
    m => { m.preservedDatabase.businessSqlAuthorized = true },
    m => { m.approvalTransfer = true },
    m => { m.retiredApprovalIds = [] },
    m => { m.mode = 'resume-scope-after-bootstrap' },
  ]
  for (const mutate of mutations) {
    const changed = structuredClone(manifest());mutate(changed)
    assert.throws(() => verifyFreshScopeTargets(changed), /fresh exclusive scope/)
  }
})

test('same supervisor preflight rejects every existing target or changed retained identity before granting any write', () => {
  let writes = 0
  const writeAfterPreflight = rows => { verifyFreshScopePreflight(rows);writes++ }
  const invalid = [[], [{ ...retained()[0], oid: 'other' }], [{ ...retained()[0], owner: 'other' }], [...retained(), ...retained()]]
  for (const datname of Object.values(SCOPE_DATABASES)) invalid.push([...retained(), { datname, oid: 'new', owner: 'postgres' }])
  for (const rows of invalid) {
    assert.throws(() => writeAfterPreflight(rows), /mismatch|exists/)
    assert.equal(writes, 0)
  }
  writeAfterPreflight(retained());assert.equal(writes, 1)
})

test('retained scope is outside every application, migration and CREATE grant even when an old ownership map is supplied', () => {
  const events = [], policy = scopePolicy([], event => events.push(event))
  policy.state.created.set(SCOPE_RETAINED_DATABASE, '65537')
  for (const bucket of ['scope','scope:migrate','team','team:migrate']) {
    assert.throws(() => policy.connect(bucket, { url: scopeUrl(SCOPE_RETAINED_DATABASE) }), /mismatch/)
    assert.throws(() => policy.grant(bucket, { url: scopeUrl(SCOPE_RETAINED_DATABASE), text: 'synthetic forbidden write' }), /mismatch/)
  }
  assert.throws(() => policy.grant('scope', { url: scopeUrl('issue184_e2e'), text: `create database "${SCOPE_RETAINED_DATABASE}"` }), /only its exact/)
  assert.equal(events.filter(event => event.event === 'query-attempt').length, 0)
})

test('real native pg rejects an old scope target before any RPC or native connection, and old resume command is retired', async () => {
  let rpcCalls = 0
  const runtime = scopeNativeRuntime(pg, () => { rpcCalls++;throw Error('unexpected RPC') }, 'scope', 'suite')
  const pool = new pg.Pool({ connectionString: scopeUrl(SCOPE_RETAINED_DATABASE) })
  try {
    await assert.rejects(pool.connect(), /mismatch/)
    assert.equal(rpcCalls, 0)
    assert.throws(() => scopeExecutionMode('--run-resume', { mode: 'resume-scope-after-bootstrap' }), /legacy resume is retired/)
    assert.throws(() => scopeExecutionMode('--run', { mode: 'resume-scope-after-bootstrap' }), /legacy resume is retired/)
    assert.doesNotThrow(() => scopeExecutionMode('--run', manifest()))
    for (const previous of SCOPE_RETIRED_APPROVALS) assert.throws(() => scopeExecutionMode('--run', manifest(), previous), /new approval reference/)
  } finally { await runtime.close();await pool.end() }
})
