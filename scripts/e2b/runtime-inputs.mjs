// Offline input identity and read-only Actions history for runtime retry suppression.
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPOSITORY = 'alexj11324/Mikka'
const WORKFLOW = '.github/workflows/e2b-official-runtime.yml'
const FAILURE_STEPS = new Set([
  'Build private versioned candidates and require official file conservation',
  'Require real Claude Code and Codex subscriptions on the private candidates',
])
const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0

/** Use the same install/recipe projection that stamps the actual worker.
 * Root scripts, Web dependencies and unrelated lock entries are not inputs. */
export function runtimeInputsDigest({ ref, cwd = process.cwd() }) {
  if (!/^[a-f0-9]{40}$/.test(ref ?? '')) throw Error('runtimeInputs:commitRequired')
  const digest = execFileSync('python3', [resolve(cwd, 'scripts/e2b/build-template.py'), '--worker-hash', '--source-ref', ref],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }).trim()
  if (!/^[a-f0-9]{40}$/.test(digest)) throw Error('runtimeInputs:invalidWorkerHash')
  return digest
}

export function releaseDecision({ workerHash, beforeWorkerHash, failedRunId, eventName, reason }) {
  if (eventName === 'workflow_dispatch') {
    if (!reason?.trim()) throw Error('runtimeInputs:retryReasonRequired')
    return { changed: true, reason: 'manual retry' }
  }
  if (eventName !== 'push') return { changed: false, reason: 'not a production push' }
  if (![workerHash, beforeWorkerHash].every(value => /^[a-f0-9]{40}$/.test(value ?? ''))) throw Error('runtimeInputs:workerHashRequired')
  if (workerHash === beforeWorkerHash) return { changed: false, reason: 'installed worker and template inputs unchanged' }
  if (failedRunId) return { changed: false, reason: `skipped: same inputs as failed run ${failedRunId}` }
  return { changed: true, reason: 'installed worker or template inputs changed' }
}

/** Compare the complete immutable push, not a stale production deployment or
 * just HEAD's parent. Missing history must fail before any paid build. */
export function pushRuntimeInputs({ ref, event, cwd = process.cwd() }, hash = runtimeInputsDigest) {
  if (!/^[a-f0-9]{40}$/.test(ref ?? '') || !/^[a-f0-9]{40}$/.test(event?.before ?? '')
    || /^0+$/.test(event.before) || event.after !== ref || event.ref !== 'refs/heads/main') throw Error('runtimeInputs:invalidPushSource')
  return { workerHash: hash({ ref, cwd }), beforeWorkerHash: hash({ ref: event.before, cwd }) }
}

async function githubRead(path, { token, fetchImpl }) {
  if (!token) throw Error('runtimeInputs:githubTokenRequired')
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(20_000), redirect: 'error', cache: 'no-store',
  })
  if (!response.ok) throw Error(`runtimeInputs:github:${response.status}`)
  return response.json()
}

async function* pages(path, key, options) {
  for (let page = 1; ; page++) {
    const data = await githubRead(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, options)
    if (!Array.isArray(data[key]) || !Number.isSafeInteger(data.total_count)) throw Error('runtimeInputs:invalidHistory')
    yield* data[key]
    if (page * 100 >= data.total_count) return
    if (!data[key].length) throw Error('runtimeInputs:incompleteHistory')
  }
}

/** Artifacts only index fingerprints. Trust the native latest run attempt and
 * its exact failing build/gate step, not a generic workflow failure. In
 * particular mainChanged, cancellation, Web and cleanup failures stay retryable.
 * A newly uploaded marker can precede the overall run's completed status by a
 * few seconds; its build/gate job must already have failed. An older rerun's
 * artifact cannot suppress work from a different attempt. */
export async function findFailedInputs({ digest, currentRunId, token, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{40}$/.test(digest ?? '')) throw Error('runtimeInputs:digestRequired')
  const options = { token, fetchImpl }, name = `e2b-runtime-inputs-${digest}`
  const artifacts = pages(`/actions/artifacts?name=${name}`, 'artifacts', options)
  for await (const artifact of artifacts) {
    const source = artifact.workflow_run
    if (artifact.expired || artifact.name !== name || !id(source?.id) || Number(source.id) === Number(currentRunId)
      || source.head_branch !== 'main' || !/^[a-f0-9]{40}$/.test(source.head_sha ?? '')) continue
    const run = await githubRead(`/actions/runs/${source.id}`, options)
    if (run.id !== source.id || run.path !== WORKFLOW || run.head_branch !== 'main' || run.head_sha !== source.head_sha
      || run.repository?.full_name !== REPOSITORY || run.head_repository?.full_name !== REPOSITORY
      || !['push', 'workflow_dispatch'].includes(run.event)
      || !(run.status === 'completed' && run.conclusion === 'failure' || run.status === 'in_progress' && run.conclusion === null)
      || !id(run.run_attempt) || !(Date.parse(artifact.created_at) >= Date.parse(run.run_started_at))) continue
    if (await failedRuntimeAttempt(run, options)) return run.id
  }
  return null
}

export async function failedRuntimeAttempt(run, options) {
  for await (const job of pages(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs', options)) {
    if (job.head_sha === run.head_sha && job.steps?.some(step => FAILURE_STEPS.has(step.name)
      && (step.conclusion === 'failure' || step.conclusion === 'timed_out'
        || job.conclusion === 'timed_out' && step.conclusion === 'cancelled'))) return true
  }
  return false
}

/** Record only while this source is still current, so a gate interrupted by a
 * newer push cannot become a sticky failure for those unchanged inputs. */
export async function rememberFailure({ sourceCommit, runId, runAttempt, token, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '') || !id(runId) || !id(runAttempt)) throw Error('runtimeInputs:attemptRequired')
  const options = { token, fetchImpl }
  if (!await failedRuntimeAttempt({ id: runId, run_attempt: runAttempt, head_sha: sourceCommit }, options)) return false
  const main = await githubRead('/git/ref/heads/main', options)
  if (main.object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(main.object.sha ?? '')) throw Error('runtimeInputs:invalidMainRef')
  return main.object.sha === sourceCommit
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const digest = runtimeInputsDigest({ ref: process.env.GITHUB_SHA })
  if (process.argv[2] === 'remember') {
    const remember = await rememberFailure({ sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT, token: process.env.GITHUB_TOKEN })
    if (remember) writeFileSync(process.argv[3], JSON.stringify({ digest, sourceCommit: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT }) + '\n')
    appendFileSync(process.env.GITHUB_OUTPUT, `digest=${digest}\nremember=${remember}\n`)
    console.log(remember ? `Remember failed runtime inputs ${digest}` : 'No current-source build/gate failure to remember')
  } else {
    const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    // Validate before network work. Render the reason only as escaped text,
    // never as commands, job outputs or operator-supplied Markdown.
    if (manual) releaseDecision({ eventName: 'workflow_dispatch', reason: process.env.RETRY_REASON })
    const recheck = process.argv[2] === 'recheck'
    let inputs
    if (!manual && !recheck) {
      let event
      try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) } catch (cause) { throw Error('runtimeInputs:invalidPushEvent', { cause }) }
      inputs = pushRuntimeInputs({ ref: process.env.GITHUB_SHA, event })
    }
    const initial = manual || recheck ? { changed: true } : releaseDecision({ ...inputs, eventName: process.env.GITHUB_EVENT_NAME })
    const failedRunId = manual || !initial.changed ? null : await findFailedInputs({ digest, currentRunId: process.env.GITHUB_RUN_ID, token: process.env.GITHUB_TOKEN })
    const decision = manual ? releaseDecision({ eventName: 'workflow_dispatch', reason: process.env.RETRY_REASON })
      : recheck ? { changed: !failedRunId, reason: failedRunId ? `skipped: same inputs as failed run ${failedRunId}` : 'queued runtime inputs have no failed attempt' }
        : releaseDecision({ ...inputs, failedRunId, eventName: process.env.GITHUB_EVENT_NAME })
    const reason = decision.reason
    console.log(`Runtime inputs ${digest}: ${reason}`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `digest=${digest}\nchanged=${decision.changed}\nskip=${!decision.changed}\n`)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nRuntime inputs: \`${digest}\`\n\n${reason}\n`)
      if (manual) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\nManual retry reason:\n<pre>'
        + process.env.RETRY_REASON.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</pre>\n')
    }
  }
}
