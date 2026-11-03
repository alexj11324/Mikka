#!/usr/bin/env node
/** Real owner HTTP acceptance. No DB writes, fake sessions or model stubs.
 * Input: two previously accepted official-harness tasks, see companion guide. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw new Error(code) }

export async function runContinuationAcceptance(env = process.env) {
  const { MIKKA_TEST_ACCOUNT_EMAIL: email, MIKKA_TEST_ACCOUNT_PASSWORD: password,
    MIKKA_EXPECTED_DEPLOYMENT_SHA: expectedSha, MIKKA_EXPECTED_BUILD: expectedBuild } = env
  if (!email || !password || !/^[a-f0-9]{40}$/.test(expectedSha ?? '') || !expectedBuild) fail('acceptance_configuration_required')
  const target = new URL(env.MIKKA_ACCEPTANCE_BASE_URL ?? 'https://app.aspectlylabs.com/mikka')
  if (target.username || target.password || target.search || target.hash || target.pathname.replace(/\/$/, '') !== '/mikka'
    || (target.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(target.hostname))) fail('acceptance_origin_invalid')
  const cases = JSON.parse(await readFile(env.MIKKA_CONTINUATION_CASES_FILE, 'utf8'))
  assert.deepEqual(cases.map(c => c.harness).sort(), ['claude_code', 'codex'])
  for (const c of cases) {
    if (![c.taskId, c.threadRunId].every(value => /^[a-f0-9-]{36}$/.test(value ?? '')) || !c.artifactTitle || !c.followup) fail('acceptance_case_invalid')
    assert.equal(c.initialBytes, c.harness === 'claude_code' ? 53 : 56)
    assert.equal(c.expectedBytes, c.harness === 'claude_code' ? 74 : 77)
    if (![c.initialSha256, c.expectedSha256].every(value => /^[a-f0-9]{64}$/.test(value ?? ''))) fail('acceptance_expected_artifact_hash_required')
  }
  // /api/version identifies a Vercel deployment by id. Pair it with the actual
  // provider metadata saved by the deployment operator, never assume an alias
  // or a READY status proves which commit is serving.
  if (expectedBuild !== expectedSha) {
    const metadata = JSON.parse(await readFile(env.MIKKA_DEPLOYMENT_METADATA_FILE, 'utf8'))
    assert.equal(metadata.id, expectedBuild)
    assert.equal(metadata.gitSource?.sha ?? metadata.meta?.githubCommitSha, expectedSha)
    assert.equal(metadata.readyState, 'READY')
  }
  let cookie = ''
  const report = { startedAt: new Date().toISOString(), origin: target.origin, expectedSha, expectedBuild, cases: [], status: 'running' }
  async function request(path, init = {}) {
    const url = new URL(path.startsWith('/mikka/') ? path : `/mikka${path}`, target.origin)
    if (url.origin !== target.origin || !url.pathname.startsWith('/mikka/')) fail('acceptance_foreign_origin')
    try {
      return await fetch(url, { ...init, headers: { origin: target.origin, 'cache-control': 'no-store', ...(cookie ? { cookie } : {}), ...init.headers },
        redirect: 'error', signal: AbortSignal.timeout(30000) })
    } catch { fail('acceptance_request_failed') }
  }
  async function json(path, init) {
    const response = await request(path, init)
    if (!response.ok) fail(`acceptance_http_${response.status}`)
    return response.json()
  }
  async function pin() { assert.equal((await json('/api/version')).build, expectedBuild, 'deployment changed during acceptance') }
  async function fileProof(runId, title, expectedBytes, expectedDigest, harness) {
    const evidence = await json(`/api/runs/${runId}/evidence`)
    assert.equal(evidence.run.harness, harness, 'actual frozen execution harness')
    assert.equal(evidence.run.credentialType, 'subscription', 'official subscription execution is required')
    assert.equal(evidence.run.subscriptionRoute, harness === 'codex' ? 'codex_cli' : 'claude_code_cli')
    const matches = evidence.artifacts.filter(artifact => artifact.title === title)
    if (matches.length !== 1) fail('acceptance_artifact_missing_or_ambiguous')
    const response = await request(matches[0].url)
    if (!response.ok) fail('acceptance_artifact_download_failed')
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.length, expectedBytes, 'actual downloaded artifact byte count')
    assert.equal(sha256(bytes), expectedDigest, 'actual artifact matches the exact expected target, not just its length')
    return { runId, harness: evidence.run.harness, model: evidence.run.model, credentialType: evidence.run.credentialType,
      subscriptionRoute: evidence.run.subscriptionRoute, artifactId: matches[0].id, version: matches[0].latestVersion, bytes: bytes.length, sha256: sha256(bytes) }
  }
  const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  await pin()
  const login = await request('/api/auth/sign-in/email', post({ email, password }))
  if (!login.ok) fail('acceptance_sign_in_failed')
  cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  if (!cookie) fail('acceptance_session_missing')
  const session = await json('/api/auth/get-session')
  assert.equal(session?.user?.email?.toLowerCase(), email.toLowerCase())
  try {
    for (const c of cases) {
      await pin()
      const before = await json(`/api/factory/tasks/${c.taskId}`)
      const original = before.task.sourceEventId
      const initialCandidate = before.candidates.find(candidate => candidate.id === before.task.candidateId)
      if (!initialCandidate) fail('acceptance_initial_candidate_required')
      for (const stage of ['review', 'verify']) assert.ok(before.attempts.some(a => a.stage === stage && a.status === 'passed' && a.candidateId === initialCandidate.id), `initial ${stage} required`)
      const initialProof = await fileProof(initialCandidate.runId, c.artifactTitle, c.initialBytes, c.initialSha256, c.harness)
      await json(`/api/mobile/threads/${c.threadRunId}`, post({ text: c.followup }))
      const deadline = Date.now() + Number(env.MIKKA_ACCEPTANCE_TIMEOUT_MS ?? 1200000)
      let complete
      let lastState = ''
      while (Date.now() < deadline) {
        await pin()
        const state = await json(`/api/factory/tasks/${c.taskId}`)
        assert.equal(state.task.id, c.taskId)
        const progress = `${state.task.sourceEventId}:${state.task.stage}:${state.task.status}`
        if (progress !== lastState) console.log(JSON.stringify({ harness: c.harness, taskId: c.taskId, stage: state.task.stage, status: state.task.status, requestEpoch: state.task.sourceEventId }))
        lastState = progress
        if (['cancelled', 'revoked', 'blocked', 'failed'].includes(state.task.status)) fail('acceptance_continuation_blocked')
        const epoch = state.task.sourceEventId
        const checks = state.attempts.filter(a => a.status === 'passed' && a.candidateId === state.task.candidateId && a.output?.requestEpoch === epoch)
        if (epoch !== original && checks.some(a => a.stage === 'review') && checks.some(a => a.stage === 'verify')) { complete = state; break }
        await delay(5000)
      }
      if (!complete) fail('acceptance_continuation_timeout')
      const candidate = complete.candidates.find(item => item.id === complete.task.candidateId)
      if (!candidate) fail('acceptance_candidate_missing')
      const checks = ['review', 'verify'].map(stage => complete.attempts.findLast(a => a.stage === stage && a.status === 'passed' && a.candidateId === candidate.id && a.output?.requestEpoch === complete.task.sourceEventId))
      assert.equal(new Set([candidate.runId, ...checks.map(a => a.runId)]).size, 3, 'independent execution, review and verification runs')
      assert.equal(checks[0].output.check.sha, checks[1].output.check.sha)
      assert.match(checks[0].output.check.sha, /^[a-f0-9]{40}$/)
      for (const check of checks) assert.equal(check.output.check.requestEpoch, complete.task.sourceEventId)
      for (const accepted of before.attempts.filter(a => a.status === 'passed')) assert.equal(complete.attempts.find(a => a.id === accepted.id)?.status, 'passed', 'accepted history retained')
      const proof = await fileProof(candidate.runId, c.artifactTitle, c.expectedBytes, c.expectedSha256, c.harness)
      // Read again after the checks so a repair that restored the earlier
      // artifact cannot hide behind the first successful download.
      await delay(1000)
      const finalProof = await fileProof(candidate.runId, c.artifactTitle, c.expectedBytes, c.expectedSha256, c.harness)
      assert.equal(finalProof.sha256, proof.sha256)
      report.cases.push({ harness: c.harness, taskId: c.taskId, previousEpoch: original, requestEpoch: complete.task.sourceEventId,
        candidateId: candidate.id, candidateSha: checks[0].output.check.sha, initialProof, finalProof,
        checks: checks.map(a => ({ attemptId: a.id, runId: a.runId, stage: a.stage, requestEpoch: a.output.requestEpoch, sha: a.output.check.sha })) })
    }
    await pin()
    report.status = 'passed'
    report.completedAt = new Date().toISOString()
    return report
  } finally {
    await request('/api/auth/sign-out', post({})).catch(() => undefined)
    cookie = ''
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await runContinuationAcceptance()
    const path = resolve(process.env.MIKKA_ACCEPTANCE_REPORT ?? '.cache/acceptance/factory-continuation.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify({ status: report.status, cases: report.cases.length, report: path }))
  } catch (error) {
    // Raw API bodies, credentials, cookies and artifact contents never go to logs.
    console.error(JSON.stringify({ status: 'failed', code: /^acceptance_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'acceptance_assertion_failed' }))
    process.exitCode = 1
  }
}
