// Actual local production build + TestAccountPool + PostgreSQL screenshots.
// This is a screenshot driver, not a browser test suite. No route interception.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { chromium } from '@playwright/test'
import { loadEnvironment, assertDeploymentIdentity } from '../test-accounts/environment.mjs'
import { TestAccountPool } from '../test-accounts/pool.mjs'
import { acquireTestAccounts, auditEvidence } from '../test-accounts/session.mjs'

const environment = await loadEnvironment()
await assertDeploymentIdentity(environment)
const db = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 3 })
const directory = '/tmp/mikka-1237-source-screenshots'
const fixture = Object.fromEntries(['issueId', 'versionId', 'eventId', 'taskId', 'candidateId', 'agentId',
  'sourceRunId', 'producerRunId', 'reviewRunId', 'verifyRunId', 'executeAttemptId', 'reviewAttemptId', 'verifyAttemptId',
  'recoveryEventId', 'outputChunkId', 'reviewCriterionId', 'verifyCriterionId'].map(key => [key, randomUUID()]))
const sourceMarker = 'Local pre-question execution / 本地提问前执行记录'
const sha = '8f418086fff9bcd42d17e32de7b7f4a968fdfc0a'
const observedAt = '2026-11-04T12:03:04.000Z'
const source = { runId: fixture.sourceRunId, sessionId: 'local-before-question-session', status: 'stopped',
  recoveryEventId: fixture.recoveryEventId, candidateSha: sha, outputChunkId: fixture.outputChunkId, observedAt }
const check = { candidateId: fixture.candidateId, sha, questionCommandSources: [source] }
const manifest = { commit: environment.deploymentSha, environmentId: environment.id, origin: environment.origin,
  startedAt: new Date().toISOString(), fixture, captures: [], checks: [],
  limits: ['Synthetic persisted local fixture only; no production data, model calls, native execution, browser test suite, or API interception.',
    'These images validate the server read and UI representation of host metadata; actual provenance admission is covered by the separate real PostgreSQL regression.'] }
let scope, browser
const save = async () => writeFile(directory + '/manifest.json', JSON.stringify(manifest, null, 2))
try {
  await new TestAccountPool(db, environment).prepare({ pairs: 2 })
  scope = await acquireTestAccounts({ database: db, environment, runId: 'question-source-ui-' + randomUUID(),
    workerId: 'normal-ui-capture', requestId: randomUUID(), ttlMs: 300_000 })
  const ownerId = scope.owner.userId
  for (const [type, ids] of [
    ['issues', [fixture.issueId]], ['issue_versions', [fixture.versionId]], ['agents', [fixture.agentId]],
    ['agent_runs', [fixture.sourceRunId, fixture.producerRunId, fixture.reviewRunId, fixture.verifyRunId]],
    ['run_chunks', [fixture.outputChunkId]],
  ]) for (const id of ids) await scope.recordResource({ type, id, ownerId })
  const tx = await db.connect()
  try {
    await tx.query('BEGIN')
    const title = 'Recovered command evidence / 恢复后的命令证据'
    const content = { type: 'doc', attrs: { mikka: { number: 1237 } }, content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Local visual fixture: cite a pre-question command while keeping the independent verdict.' }] },
    ] }
    await tx.query('INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,$3,$4,\'todo\',\'normal\')',
      [fixture.issueId, ownerId, title, JSON.stringify(content)])
    await tx.query('INSERT INTO issue_versions(id,"issueId","userId",revision,title,content,status,priority) VALUES($1,$2,$3,1,$4,$5,\'todo\',\'normal\')',
      [fixture.versionId, fixture.issueId, ownerId, title, JSON.stringify(content)])
    await tx.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,$3,\'codex\')', [fixture.agentId, ownerId, 'Local source fixture'])
    const reports = [
      null,
      { summary: 'Local candidate delivery fixture' },
      { criteria: [{ criterionId: fixture.reviewCriterionId, text: 'Independent review still needs a change', passed: false,
        evidence: 'Reviewed the cited local observation run-chunk:' + fixture.outputChunkId }] },
      { criteria: [{ criterionId: fixture.verifyCriterionId, text: 'Frozen command observation is available', passed: true,
        evidence: 'Checked local observation run-chunk:' + fixture.outputChunkId, command: 'node --version', exitCode: 0 }],
        verify: { status: 'passed', command: 'node --version', exitCode: 0 } },
    ]
    const runs = [fixture.sourceRunId, fixture.producerRunId, fixture.reviewRunId, fixture.verifyRunId]
    for (let i = 0; i < runs.length; i++) await tx.query(
      'INSERT INTO agent_runs(id,"userId","agentId","issueId",status,kind,prompt,"sessionId",report,"startedAt","finishedAt",outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [runs[i], ownerId, fixture.agentId, fixture.issueId, i === 0 ? 'stopped' : 'succeeded', ['implement', 'implement', 'review', 'verify'][i],
        i === 0 ? sourceMarker : 'Local screenshot fixture; no real execution', 'local-source-ui-session-' + i,
        reports[i] === null ? null : JSON.stringify(reports[i]), '2026-11-04T12:00:00.000Z', '2026-11-04T12:05:00.000Z', i === 0 ? 'blocked' : 'done'])
    await tx.query('UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1', [fixture.sourceRunId, source.sessionId])
    await tx.query('INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,1,$3,$4)',
      [fixture.outputChunkId, fixture.sourceRunId, JSON.stringify({ type: 'text', text: sourceMarker }), observedAt])
    await tx.query('INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,"issueId","deliveredAt") VALUES($1,$2,\'user_message\',$3,$4,$5,now())',
      [fixture.eventId, ownerId, 'question-source-ui:' + fixture.eventId, JSON.stringify({ text: 'Local visual fixture only' }), fixture.issueId])
    await tx.query('INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,revision,"attemptId",reason) VALUES($1,$2,$3,$4,$5,\'review\',\'failed\',24,$6,$7)',
      [fixture.taskId, ownerId, fixture.issueId, fixture.eventId, JSON.stringify({ kind: 'factory', needsSpec: false,
        missingInformation: [], missingPermissions: [], rationale: 'Local source-attribution fixture' }), fixture.reviewAttemptId,
      'Independent review requires a change / 独立审查仍需修改'])
    await tx.query('INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId","machineName") VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [fixture.candidateId, fixture.taskId, sha, 'alexj11324/Mikka', 'local-visual-fixture', 'Visual evidence only', fixture.producerRunId, 'Docker visual fixture'])
    const attempts = [fixture.executeAttemptId, fixture.reviewAttemptId, fixture.verifyAttemptId]
    for (let i = 0; i < attempts.length; i++) await tx.query(
      'INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"candidateId","runId",reason,output) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9)',
      [attempts[i], fixture.taskId, ['execute', 'review', 'verify'][i], i + 1, i === 1 ? 'failed' : 'passed', fixture.candidateId,
        runs[i + 1], 'Local visual fixture', JSON.stringify(i === 0 ? {} : { check })])
    await tx.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1', [fixture.taskId, fixture.candidateId])
    await tx.query('COMMIT')
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  const response = await scope.owner.request('/api/factory/tasks/' + fixture.taskId)
  assert.equal(response.status, 200)
  const detail = await response.json()
  const origin = { runId: source.runId, sessionId: source.sessionId, status: source.status,
    recoveryEventId: source.recoveryEventId, observedAt: source.observedAt }
  assert.deepEqual(detail.checks.map(row => row.commandSources), [[origin], [origin]])
  assert.deepEqual(detail.checks.map(row => row.status), ['failed', 'passed'])
  assert.equal(detail.task.status, 'failed')
  const peerResponse = await scope.peer.request('/api/factory/tasks/' + fixture.taskId)
  assert.equal(peerResponse.status, 404)
  manifest.checks.push({ name: 'actual-task-detail', status: response.status, peerStatus: peerResponse.status,
    commandSources: detail.checks.map(row => row.commandSources), verdicts: detail.checks.map(row => row.status) })
  await mkdir(directory, { recursive: true })
  browser = await chromium.launch({ headless: false, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] })
  const context = await browser.newContext({ storageState: scope.owner.storageStatePath, viewport: { width: 1440, height: 960 },
    colorScheme: 'light', timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  const copy = Object.fromEntries(await Promise.all(['zh-CN', 'en'].map(async locale => [locale, JSON.parse(await readFile('messages/' + locale + '.json', 'utf8'))])))
  async function screenshot(name, details) {
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(async () => Promise.all(document.documentElement.getAnimations({ subtree: true })
      .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => {}))))
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const path = directory + '/' + name + '.png'
    await page.screenshot({ path })
    manifest.captures.push({ name: name + '.png', ...details, at: new Date().toISOString(),
      sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
    await save()
  }
  for (const locale of ['zh-CN', 'en']) for (const width of [1440, 390]) for (const scheme of ['light', 'dark']) {
    await scope.assertActive()
    const height = width === 390 ? 844 : 960
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(environment.origin + environment.basePath + '/' + locale + '?issue=' + fixture.issueId, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: locale === 'en' ? 'Factory acceptance' : 'Factory 验收', exact: true }).click()
    const label = page.getByText(copy[locale].FactoryAcceptance.questionCommandSource, { exact: true })
    await label.first().waitFor({ state: 'visible' })
    assert.equal(await label.count(), 2)
    await screenshot((locale === 'en' ? 'en' : 'zh') + '-source-' + width + '-' + scheme, { locale, width, height, scheme, state: 'attributed-failed-review' })
  }
  // A normal click follows the cited execution, independently of the review thread.
  await page.getByRole('button', { name: copy.en.FactoryAcceptance.sourceExecution, exact: true }).first().click()
  await page.getByText(sourceMarker, { exact: false }).first().waitFor({ state: 'visible' })
  manifest.checks.push({ name: 'source-execution-navigation', runId: fixture.sourceRunId, visibleMarker: sourceMarker })
  await screenshot('en-source-thread-390-dark', { locale: 'en', width: 390, height: 844, scheme: 'dark', state: 'source-thread' })
  assert.equal((await db.query('SELECT count(*)::int AS count FROM agent_runs WHERE "userId"=$1 AND status IN (\'queued\',\'preparing\',\'running\',\'paused\',\'waiting_input\',\'finishing\')', [ownerId])).rows[0].count, 0)
  manifest.finishedAt = new Date().toISOString()
  await save()
  const audit = await auditEvidence([directory], { environment })
  console.log(JSON.stringify({ captures: manifest.captures.length, checks: manifest.checks, audit, manifest: directory + '/manifest.json',
    fixtureDisposition: 'retained local fixture; account lease quarantined' }))
} finally {
  await browser?.close()
  await scope?.release({ outcome: 'dirty' })
  await db.end()
}
