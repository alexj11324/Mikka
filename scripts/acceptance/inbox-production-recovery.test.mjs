import assert from 'node:assert/strict'
import test from 'node:test'
import { CORE_WORKFLOW } from './self-hosted-production-target.mjs'
import { inboxBindingJournal, inboxJournalEnvelope, INBOX_JOURNAL_PREFIX, readInboxRecovery } from './inbox-production-recovery.mjs'

const NOW = Date.parse('2026-11-09T22:00:00Z'), SHA = 'a'.repeat(40), HEAD = 'b'.repeat(40)
const UUID = index => '10000000-0000-4000-8000-' + String(index).padStart(12, '0')
const API = 'https://api.github.com/repos/alexj11324/Mikka'
const TOKEN = 'private-github-token-canary', SIGNED = 'https://resultsa.blob.core.windows.net/logs/job.txt?sig=private-signed-url-canary'
const journal = (patch = {}) => inboxBindingJournal({ schema: 1, purpose: 'mikka1820-exact-suggestion', applicationSha: SHA,
  headSha: HEAD, driverRunId: 123, driverAttempt: 1, window: { commentId: 45, markerSha256: 'c'.repeat(64) },
  ownerHash: 'd'.repeat(64), workspaceId: UUID(1), suggestionId: UUID(2), originalWorkspaceId: UUID(1),
  selectedWorkspaceId: UUID(3), sessionIdHash: 'e'.repeat(64), priorSessionIdHashes: [], recoveryOf: null,
  nonce: UUID(4), sourceUrl: 'https://github.com/alexj11324/Mikka-handoff/issues/73#issuecomment-91',
  occurredAt: new Date(NOW - 120_000).toISOString(), action: 'reply', required: false, externalSourceClosed: true,
  sourceEventId: 91, sourceIssueNumber: 73, state: 'bound_before_mutation', observedAt: new Date(NOW - 60_000).toISOString(), ...patch })

function fixture(options = {}) {
  const bound = inboxJournalEnvelope(journal()), calls = []
  const reference = { schema: 1, purpose: 'mikka1820-journal-recovery', runId: 123, attempt: 1, jobId: 71, journalSha256: bound.sha256 }
  const selected = { selected: true, driverRunId: 123, driverRunAttempt: 2, applicationSha: SHA, headSha: HEAD, window: { phase: 'cleanup' } }
  const run = { id: 123, run_attempt: 1, status: 'completed', conclusion: 'cancelled', event: 'workflow_run', head_branch: 'main',
    head_sha: SHA, path: CORE_WORKFLOW, repository: { full_name: 'alexj11324/Mikka' }, head_repository: { full_name: 'alexj11324/Mikka' }, ...options.run }
  const job = { id: 71, run_id: 123, run_attempt: 1, head_sha: SHA, head_branch: 'main', name: 'Core production API and gateway acceptance',
    run_url: API + '/actions/runs/123', status: 'completed', started_at: new Date(NOW - 120_000).toISOString(),
    completed_at: new Date(NOW - 30_000).toISOString(), steps: [{ name: 'Verify the exact Inbox fixture or inventory under its current release window',
      status: 'completed', conclusion: 'cancelled' }], ...options.job }
  const line = value => '2026-11-09T21:59:00.1234567Z ' + INBOX_JOURNAL_PREFIX + JSON.stringify(value)
  const log = options.log?.({ bound, line }) ?? 'unrelated private-provider-response-canary\n' + line(bound) + '\n'
  const fetchImpl = async (url, init) => {
    const headers = new Headers(init.headers); calls.push({ url, authenticated: headers.has('authorization') })
    assert.equal(init.method, 'GET'); assert.equal(headers.has('cookie'), false)
    if (url === SIGNED) {
      assert.equal(init.redirect, 'error'); assert.equal(headers.has('authorization'), false)
      return new Response(log, { status: options.logStatus ?? 200 })
    }
    assert.equal(headers.get('authorization'), 'Bearer ' + TOKEN)
    if (url === API + '/actions/runs/123/attempts/1') return Response.json(run)
    if (url === API + '/actions/runs/123/attempts/1/jobs?per_page=100') return Response.json({ total_count: 1, jobs: [job] })
    if (url === API + '/actions/jobs/71/logs') {
      assert.equal(init.redirect, 'manual')
      return new Response(null, { status: 302, headers: { location: options.location ?? SIGNED } })
    }
    assert.fail('unlisted metadata path')
  }
  return { calls, bound, reference, selected, args: { reference, selected, env: { GH_TOKEN: TOKEN }, fetchImpl, now: () => NOW } }
}

test('completed failed/cancelled attempt proves the exact journal without forwarding credentials to the log download', async () => {
  const f = fixture(), result = await readInboxRecovery(f.args)
  assert.deepEqual(result.journal, f.bound.journal); assert.equal(result.proof.source, 'completed_github_job_log')
  assert.equal(f.calls.at(-1).authenticated, false)
  for (const secret of [TOKEN, 'private-signed-url-canary', 'private-provider-response-canary'])
    assert.equal(JSON.stringify(result).includes(secret), false)
})

test('foreign source, workflow, repository, attempt and active original job cannot authorize recovery', async () => {
  for (const options of [
    ...[{ head_sha: 'c'.repeat(40) }, { path: '.github/workflows/other.yml' }, { head_branch: 'someone' },
      { event: 'workflow_dispatch' }, { run_attempt: 2 }, { status: 'in_progress' },
      { repository: { full_name: 'someone/else' } }, { head_repository: { full_name: 'someone/fork' } }].map(run => ({ run })),
    ...[{ run_id: 456 }, { run_attempt: 2 }, { run_attempt: undefined }, { head_sha: 'c'.repeat(40) }, { name: 'Other job' }, { status: 'in_progress' },
      { steps: [] }, { id: 72 }].map(job => ({ job })),
  ]) await assert.rejects(readInboxRecovery(fixture(options).args), /recovery_proof_invalid/)
  const f = fixture(); f.selected.driverRunAttempt = 1
  await assert.rejects(readInboxRecovery(f.args), /recovery_proof_invalid/); assert.equal(f.calls.length, 0)
})

test('a 1856 continuation cannot rename the original 325 run or journal into its own source', async () => {
  const original = '32523d5955479de800a94ba002c551666c4ddeb1'
  const run = fixture({ run: { head_sha: original } })
  run.selected.purpose = 'inbox-1820-followup-selection'; run.selected.pr = 1856
  await assert.rejects(readInboxRecovery(run.args), /recovery_proof_invalid/)
  assert.equal(run.calls.some(call => call.url.includes('/logs')), false)
  const oldJournal = inboxJournalEnvelope(journal({ applicationSha: original }))
  const log = fixture({ log: ({ line }) => line(oldJournal) })
  log.selected.purpose = 'inbox-1820-followup-selection'; log.selected.pr = 1856
  log.reference.journalSha256 = oldJournal.sha256
  await assert.rejects(readInboxRecovery(log.args), /recovery_log_invalid/)
})

test('missing, duplicate, conflicting, noncanonical and unanchored records fail closed instead of guessing first or last', async () => {
  const options = [
    { log: () => 'no journal' },
    { log: ({ bound, line }) => line(bound) + '\n' + line(bound) },
    { log: ({ bound, line }) => line(bound) + '\n' + line(inboxJournalEnvelope(journal({ suggestionId: UUID(8), state: 'cleaned' }))) },
    { log: ({ bound, line }) => 'untrusted prefix ' + line(bound) },
    { log: ({ bound }) => INBOX_JOURNAL_PREFIX + JSON.stringify(bound, null, 2) },
    { log: ({ bound, line }) => line({ ...bound, sha256: 'f'.repeat(64) }) },
  ]
  for (const option of options) await assert.rejects(readInboxRecovery(fixture(option).args), /recovery_log_invalid/)
  const f = fixture(); f.reference.journalSha256 = 'f'.repeat(64)
  await assert.rejects(readInboxRecovery(f.args), /recovery_log_invalid/)
})

test('later states must preserve the same closed binding and source/attempt/time', async () => {
  const f = fixture({ log: ({ bound, line }) => line(bound) + '\n' + line(inboxJournalEnvelope(journal({ state: 'cleaned',
    observedAt: new Date(NOW - 40_000).toISOString() }))) })
  assert.deepEqual((await readInboxRecovery(f.args)).journal, f.bound.journal)
  for (const patch of [{ driverAttempt: 2 }, { headSha: 'c'.repeat(40) }, { observedAt: new Date(NOW + 1_000).toISOString() }])
    await assert.rejects(readInboxRecovery(fixture({ log: ({ line }) => line(inboxJournalEnvelope(journal(patch))) }).args), /recovery_log_invalid/)
  assert.throws(() => inboxBindingJournal({ ...journal(), token: TOKEN }), /recovery_proof_invalid/)
})

test('download failure, oversize content and a foreign redirect never leak URLs or confer cleanup authority', async () => {
  for (const options of [{ logStatus: 403 }, { location: 'http://localhost/log' }, { location: 'https://someone.example/log' },
    { log: () => 'x'.repeat(8_000_001) }]) {
    const f = fixture(options)
    await assert.rejects(readInboxRecovery(f.args), error => {
      assert.match(error.message, /^recovery_(read_failed|log_invalid)$/)
      assert.equal(error.message.includes(TOKEN), false); assert.equal(error.message.includes('sig='), false)
      return true
    })
  }
})
