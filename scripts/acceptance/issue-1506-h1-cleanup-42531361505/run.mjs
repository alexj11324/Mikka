// One original H1 idle follow-up. No model message, fixture change, or automatic retry.
// Intended cwd: repository root, with immutable original source in driver-source/.
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DRIVER_SHA = 'ab2fc19909a83b16c3276b0b2353f6055572283b'
const ORIGINAL_SHA256 = 'ece3a671cf765a1656a39342a34bab62f59be55416b711d82d18fd3f3aa6abe4'
const FIXTURE_PATH = 'scripts/acceptance/issue-1506-alex/receipts/fixtures-ready-42286389783.json'
const FIXTURE_SHA256 = 'aa58d54fee5826627696a0d1328cb0acaab2707f1d4254aa15f1b6ae420fb9fe'
const here = dirname(fileURLToPath(import.meta.url)), driver = resolve('driver-source')
const output = resolve('h1-cleanup-report'), hash = value => createHash('sha256').update(value).digest('hex')
const check = (condition, code) => { if (!condition) throw Error(code) }
const safeError = error => /^[a-z][a-z0-9_]{0,80}$/.test(error?.message ?? '') ? error.message : 'cleanup_failed'
const report = {
  schemaVersion: 1, issue: 1506, phase: 'alex-natural-h1-idle-followup',
  status: 'needs_followup', startedAt: new Date().toISOString(), driverSha: DRIVER_SHA,
  originalNaturalRun: 42531361505, originalReportSha256: ORIGINAL_SHA256,
  fixtureReceiptSha256: FIXTURE_SHA256, syncCalls: 0, stopAttempts: 0,
  stopAcknowledged: null, idleVerified: false, signedOut: false,
  modelMessages: 0, taskCreationRequests: 0, modelSelectionWrites: 0,
  fixtureHideWrites: 0, workspaceDeleteWrites: 0, groupWrites: 0,
  automaticRetry: false, acceptanceVerdict: 'not_produced'
}
mkdirSync(output, { recursive: true })
const save = () => writeFileSync(join(output, 'cleanup.json'), JSON.stringify(report, null, 2) + '\n')
let diagnostics = null
save()
try {
  check(process.argv[2] === 'cleanup-h1', 'explicit_cleanup_h1_required')
  check(process.env.DRIVER_SHA === DRIVER_SHA, 'original_driver_binding_mismatch')
  const raw = readFileSync(join(here, 'input/coordinator-cache-turns-haiku.json'))
  check(hash(raw) === ORIGINAL_SHA256, 'original_report_hash_mismatch')
  const original = JSON.parse(raw)
  check(original.issue === 1506 && original.schemaVersion === 1 && original.case === 'complete-short-turns' &&
    original.fixture?.key === 'haiku' && original.messageSendAttempts === 1 && original.turns?.length === 1,
  'original_h1_scope_invalid')
  const turn = original.turns[0]
  check(turn.index === 1 && turn.messageSendAttempted === true && /^wrun_[a-zA-Z0-9_-]{1,160}$/.test(turn.workflowRunId),
    'original_h1_run_invalid')
  const fixtureBytes = readFileSync(join(driver, FIXTURE_PATH))
  check(hash(fixtureBytes) === FIXTURE_SHA256, 'original_fixture_hash_mismatch')
  const { alexSession, ALEX_OWNER_ID } = await import(pathToFileURL(join(driver, 'scripts/acceptance/issue-1506-readonly/alex-session.mjs')))
  const { validateFixtureReceipt, selectFixtureWorkspace, verifyOwnedFixture, fixtureRef } =
    await import(pathToFileURL(join(driver, 'scripts/acceptance/issue-1506-alex/coordinator-fixtures.mjs')))
  const { readJson, rpc, validateChat } =
    await import(pathToFileURL(join(driver, 'scripts/acceptance/issue-1504-1506/coordinator-baseline.mjs')))
  const fixtures = validateFixtureReceipt(JSON.parse(fixtureBytes), { ready: true })
  const fixture = fixtures.fixtures.find(row => row.key === original.fixture.key)
  check(fixture?.botId === original.fixture.botId && fixtures.runKey === original.fixture.runKey &&
    fixtures.workspace.ref === original.workspace?.ref && fixtureRef(fixture.botId) === original.botRef,
  'original_fixture_scope_mismatch')
  report.scope = { ownerRef: fixtureRef(ALEX_OWNER_ID), workspaceId: fixtures.workspace.id,
    workspaceRef: fixtures.workspace.ref, fixtureKey: fixture.key, fixtureRunKey: fixtures.runKey,
    botId: fixture.botId, botRef: original.botRef, originalWorkflowRunId: turn.workflowRunId,
    originalApplicationSha: original.applicationSha, originalSentAt: turn.sentAt }
  report.originalResult = { status: original.status, error: original.error,
    cleanupStatus: original.cleanup?.status, H1Status: turn.status, H2H3NotReplayed: true }
  save()
  await alexSession(async session => {
    report.observedApplicationSha = session.version.build
    await selectFixtureWorkspace(session, fixtures)
    report.workspaceSelectedThroughOriginalHelper = true
    const bots = await readJson(session, '/api/bots')
    const matches = Array.isArray(bots) ? bots.filter(bot => bot.id === fixture.botId) : []
    check(matches.length === 1, 'fixture_missing')
    verifyOwnedFixture(matches[0], fixtures, fixture)
    report.ownershipVerified = true
    const read = async () => {
      report.syncCalls++; save()
      const chat = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [fixture.botId]))
      check(chat.botId === fixture.botId, 'fixture_scope_mismatch')
      return chat
    }
    const project = chat => ({ observedAt: new Date().toISOString(), working: chat.working,
      activeStream: Boolean(chat.streamRunId), streamRunId: typeof chat.streamRunId === 'string' ? chat.streamRunId : null })
    let chat = await read()
    report.before = project(chat); save()
    if (!chat.working && !chat.streamRunId) {
      report.idleVerified = true; report.outcome = 'already_idle_no_stop'; return
    }
    if (chat.streamRunId !== turn.workflowRunId) {
      report.outcome = 'active_run_differs_or_unbound_no_stop'; return
    }
    report.stopAttempts = 1; report.stopRequestedAt = new Date().toISOString(); save()
    try {
      const stopped = await rpc(session, 'coordinator.stopCoordinatorTurn', [fixture.botId])
      report.stopAcknowledged = stopped?.stopped === true
    } catch (error) {
      report.stopError = safeError(error)
      report.stopOutcome = 'unknown_no_retry'
    }
    save()
    // Exactly one authoritative read after the one permitted original Stop call.
    chat = await read()
    report.after = project(chat)
    report.idleVerified = !chat.working && !chat.streamRunId
    report.outcome = report.idleVerified ? 'idle_after_single_stop' : 'still_active_no_retry'
  }, { expectedSha: null, deadlineAt: Date.now() + 180_000, onSession: value => { diagnostics = value } })
} catch (error) {
  report.error = safeError(error)
} finally {
  report.signedOut = diagnostics?.signOut?.succeeded === true
  report.session = diagnostics
  report.status = report.idleVerified && report.signedOut ? 'cleanup_complete' : 'needs_followup'
  report.finishedAt = new Date().toISOString(); save()
}
console.log(JSON.stringify(report))
if (report.status !== 'cleanup_complete') process.exitCode = 1
