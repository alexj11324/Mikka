import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { governanceRecoveryReference, governanceBindingJournal, governanceJournalEnvelope,
  verifyGovernanceJournalChain, readGovernanceRecovery, governanceRecoveryFailure,
  GOVERNANCE_JOB, GOVERNANCE_STEP, GOVERNANCE_JOURNAL_PREFIX } from './self-hosted-production-governance-recovery.mjs'
import { CORE_WORKFLOW } from './self-hosted-production-target.mjs'

const SOURCE = 'a'.repeat(40), HEAD = 'b'.repeat(40), HASH = 'c'.repeat(64)
const API = 'https://api.github.com/repos/alexj11324/Mikka', REPOSITORY = 'alexj11324/Mikka'
const START = Date.parse('2026-11-10T05:00:00.000Z'), NOW = START + 240000
const ID = '10000000-0000-4000-8000-000000000001', ORG = '20000000-0000-4000-8000-000000000001'
const hash = value => createHash('sha256').update(value).digest('hex')
function journal(overrides = {}) {
  return { schema: 1, purpose: 'mikka1856-owned-organization', applicationSha: SOURCE, headSha: HEAD,
    driverRunId: 101, driverAttempt: 1, window: { commentId: 201, markerSha256: HASH }, ownerHash: hash('owner'),
    originalWorkspaceId: ID, selectedWorkspaceId: ID, sessionIdHash: hash('session'), priorSessionIdHashes: [], recoveryOf: null,
    nonce: ID, baselineOrgHashes: [hash('baseline')], intentAt: new Date(START).toISOString(),
    organizationId: null, organizationCreatedAt: null, ownershipVerified: false, emptyBindingsVerified: false,
    archiveIntent: false, archiveConfirmed: false, state: 'create_intent', sequence: 1, previousSha256: null,
    observedAt: new Date(START + 1000).toISOString(), ...overrides }
}
function records() {
  const first = governanceJournalEnvelope(journal())
  const second = governanceJournalEnvelope(journal({ organizationId: ORG, state: 'candidate_recorded',
    sequence: 2, previousSha256: first.sha256, observedAt: new Date(START + 2000).toISOString() }))
  const third = governanceJournalEnvelope(journal({ organizationId: ORG, organizationCreatedAt: new Date(START).toISOString(),
    ownershipVerified: true, emptyBindingsVerified: true, archiveIntent: true, state: 'archive_intent',
    sequence: 3, previousSha256: second.sha256, observedAt: new Date(START + 3000).toISOString() }))
  return [first, second, third]
}
function fixture(change = () => {}) {
  const chain = records(), reference = { schema: 1, purpose: 'mikka1856-governance-journal-recovery',
    runId: 101, attempt: 1, jobId: 303, journalSha256: chain.at(-1).sha256 }
  const selected = { selected: true, applicationSha: SOURCE, headSha: HEAD, driverRunId: 101, driverRunAttempt: 2,
    window: { phase: 'cleanup' } }
  const run = { id: 101, run_attempt: 1, status: 'completed', conclusion: 'failure', event: 'workflow_run',
    head_branch: 'main', head_sha: SOURCE, path: CORE_WORKFLOW, repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY } }
  const job = { id: 303, name: GOVERNANCE_JOB, run_id: 101, run_attempt: 1, head_sha: SOURCE, head_branch: 'main',
    status: 'completed', conclusion: 'failure', run_url: API + '/actions/runs/101',
    started_at: new Date(START).toISOString(), completed_at: new Date(START + 180000).toISOString(),
    steps: [{ name: GOVERNANCE_STEP, status: 'completed', conclusion: 'failure' }] }
  const state = { reference, selected, run, job, chain, totalCount: 1, jobs: [job],
    redirect: 'https://fixture.blob.core.windows.net/logs/owned.txt?temporary=opaque',
    log: 'unrelated output\n' + chain.map(row => row.journal.observedAt + ' ' + GOVERNANCE_JOURNAL_PREFIX + JSON.stringify(row)).join('\n') }
  change(state)
  const calls = [], token = randomUUID(), secret = 'private-' + randomUUID()
  state.log += '\n' + secret + '\n'
  const fetchImpl = async (url, init) => {
    calls.push({ url, authenticated: new Headers(init.headers).has('authorization'), redirect: init.redirect })
    if (url.startsWith(API)) assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + token)
    else assert.equal(new Headers(init.headers).has('authorization'), false)
    if (url === API + '/actions/runs/101/attempts/1') return Response.json(state.run)
    if (url === API + '/actions/runs/101/attempts/1/jobs?per_page=100') return Response.json({ total_count: state.totalCount, jobs: state.jobs })
    if (url === API + '/actions/jobs/303/logs') return new Response(null, { status: 302, headers: { location: state.redirect } })
    if (url === state.redirect) return new Response(state.log)
    throw new Error('unexpected fixture request')
  }
  return { args: { reference, selected, env: { GH_TOKEN: token }, now: () => NOW, fetchImpl }, state, calls, secret }
}
const assertRefusal = async change => {
  const f = fixture(change)
  await assert.rejects(readGovernanceRecovery(f.args), error => {
    const closed = governanceRecoveryFailure(error)
    assert.ok(closed && closed.code.startsWith('governance_recovery_'))
    assert.ok(!JSON.stringify(closed).includes(f.secret))
    return true
  })
  return f
}

test('recovery reference is a closed same-run pointer, never a URL or credential transport', () => {
  const value = fixture().state.reference
  assert.deepEqual(governanceRecoveryReference(value), value)
  for (const extra of [{ cookie: randomUUID() }, { sourceSha: SOURCE }, { url: 'https://example.test/' }])
    assert.throws(() => governanceRecoveryReference({ ...value, ...extra }))
  for (const change of [{ schema: 2 }, { purpose: 'mikka1820-journal-recovery' }, { runId: 0 }, { attempt: -1 }, { journalSha256: 'bad' }])
    assert.throws(() => governanceRecoveryReference({ ...value, ...change }))
})
test('journal permits a durable unknown-create intent, but rejects credentials, raw identities and impossible ownership', () => {
  assert.equal(governanceBindingJournal(journal()).organizationId, null)
  for (const change of [{ cookie: randomUUID() }, { email: 'offline@example.test' }, { ownerHash: 'raw-owner-id' },
    { baselineOrgHashes: [ORG] }, { emptyBindingsVerified: true }, { archiveConfirmed: true }, { previousSha256: HASH }])
    assert.throws(() => governanceBindingJournal({ ...journal(), ...change }))
})
test('canonical progression binds a nullable create intent to exactly one immutable Organization', () => {
  const rows = records()
  assert.equal(verifyGovernanceJournalChain(rows).journal.organizationId, ORG)
  for (const mutate of [
    list => { list[1].journal.sequence = 3 },
    list => { list[2].journal.previousSha256 = HASH },
    list => { list[2].journal.organizationId = ID },
    list => { list[2].journal.baselineOrgHashes = [] },
    list => { list[2].journal.observedAt = new Date(START).toISOString() },
  ]) {
    const copy = structuredClone(rows); mutate(copy); assert.throws(() => verifyGovernanceJournalChain(copy))
  }
})
test('the exact completed attempt and Gov step yield only the latest closed journal projection', async () => {
  const f = fixture(), value = await readGovernanceRecovery(f.args)
  assert.equal(value.reference.jobId, 303); assert.equal(value.journal.organizationId, ORG)
  assert.equal(value.proof.journalRecords, 3)
  assert.ok(!JSON.stringify(value).includes(f.secret))
  assert.deepEqual(f.calls.map(row => row.authenticated), [true, true, true, false])
  assert.equal(f.calls[2].redirect, 'manual'); assert.equal(f.calls[3].redirect, 'error')
})
test('the latest unknown-create intent remains recoverable without guessing an Organization ID', async () => {
  const f = fixture(state => {
    state.log = GOVERNANCE_JOURNAL_PREFIX + JSON.stringify(state.chain[0])
    state.reference.journalSha256 = state.chain[0].sha256
  })
  const value = await readGovernanceRecovery(f.args)
  assert.equal(value.journal.organizationId, null); assert.equal(value.proof.journalRecords, 1)
})
for (const [name, change] of [
  ['different current run', state => { state.selected.driverRunId = 102 }],
  ['current attempt instead of earlier', state => { state.selected.driverRunAttempt = 1 }],
  ['owner-audit phase', state => { state.selected.window.phase = 'owner-audit' }],
  ['unselected source', state => { state.selected.selected = false }],
  ['other source', state => { state.run.head_sha = 'f'.repeat(40) }],
  ['other workflow', state => { state.run.path = '.github/workflows/other.yml' }],
  ['foreign repository', state => { state.run.head_repository.full_name = 'someone/Mikka' }],
  ['other triggering event', state => { state.run.event = 'workflow_dispatch' }],
  ['non-main source', state => { state.run.head_branch = 'feature' }],
  ['unfinished original run', state => { state.run.status = 'in_progress' }],
  ['incomplete attempt listing', state => { state.totalCount = 2 }],
  ['wrong job attempt', state => { state.job.run_attempt = 2 }],
  ['missing actual job attempt', state => { delete state.job.run_attempt }],
  ['wrong job source', state => { state.job.head_sha = 'f'.repeat(40) }],
  ['wrong job', state => { state.job.name = 'unrelated job' }],
  ['future job completion', state => { state.job.completed_at = new Date(NOW + 1000).toISOString() }],
  ['unfinished step', state => { state.job.steps[0].status = 'in_progress' }],
  ['unexecuted step', state => { state.job.steps[0].conclusion = 'skipped' }],
  ['old Inbox step', state => { state.job.steps[0].name = 'Verify the exact Inbox fixture or inventory under its current release window' }],
  ['duplicate matching steps', state => { state.job.steps.push({ ...state.job.steps[0] }) }],
  ['foreign log host', state => { state.redirect = 'https://example.test/logs' }],
  ['cleartext log redirect', state => { state.redirect = 'http://fixture.blob.core.windows.net/logs' }],
]) test(name + ' is refused before any owner action', () => assertRefusal(change))
test('a stale earlier record hash cannot override later immutable cleanup state', () => assertRefusal(state => {
  state.reference.journalSha256 = state.chain[0].sha256
}))
test('closed cleanup is not replayed as an outstanding fixture', () => assertRefusal(state => {
  const previous = state.chain.at(-1)
  const last = governanceJournalEnvelope({ ...previous.journal, state: 'closed', archiveConfirmed: true,
    sequence: 4, previousSha256: previous.sha256, observedAt: new Date(START + 4000).toISOString() })
  state.log += '\n' + GOVERNANCE_JOURNAL_PREFIX + JSON.stringify(last)
  state.reference.journalSha256 = last.sha256
}))
test('a changed head in a canonical record is refused even when the supplied digest is recomputed', () => assertRefusal(state => {
  const rows = state.chain.map(row => governanceJournalEnvelope({ ...row.journal, headSha: 'f'.repeat(40) }))
  state.log = rows.map(row => GOVERNANCE_JOURNAL_PREFIX + JSON.stringify(row)).join('\n')
  state.reference.journalSha256 = rows.at(-1).sha256
}))
test('a syntactically valid record outside its actual job time is refused', () => assertRefusal(state => {
  const row = governanceJournalEnvelope(journal({ observedAt: new Date(START + 200000).toISOString() }))
  state.log = GOVERNANCE_JOURNAL_PREFIX + JSON.stringify(row); state.reference.journalSha256 = row.sha256
}))
for (const [name, transform] of [
  ['unexpected receipt field', text => text.replace('"sha256":', '"rawCookie":"forbidden","sha256":')],
  ['changed digest', text => text.replace(/"sha256":"[a-f0-9]{64}"/, '"sha256":"' + '0'.repeat(64) + '"')],
  ['embedded non-receipt prefix', text => text.replace(GOVERNANCE_JOURNAL_PREFIX, 'not-a-receipt ' + GOVERNANCE_JOURNAL_PREFIX)],
  ['noncanonical spacing', text => text.replace('{"sha256":', '{ "sha256":')],
  ['duplicate sequence', text => text + '\n' + text.split('\n')[1]],
]) test(name + ' is rejected', () => assertRefusal(state => { state.log = transform(state.log) }))
test('a recomputed canonical receipt cannot regress previously proved ownership or archive state', () => assertRefusal(state => {
  const previous = state.chain.at(-1)
  const last = governanceJournalEnvelope({ ...previous.journal, emptyBindingsVerified: false, archiveIntent: false,
    state: 'unresolved', sequence: 4, previousSha256: previous.sha256, observedAt: new Date(START + 4000).toISOString() })
  state.log += '\n' + GOVERNANCE_JOURNAL_PREFIX + JSON.stringify(last)
  state.reference.journalSha256 = last.sha256
}))
test('an oversized untrusted log is refused before journal use', () => assertRefusal(state => {
  state.log = 'x'.repeat(8000001)
}))
test('absent GitHub metadata credential fails before network access', async () => {
  const f = fixture(); delete f.args.env.GH_TOKEN
  await assert.rejects(readGovernanceRecovery(f.args)); assert.equal(f.calls.length, 0)
})
