// Offline input identity and read-only Actions history for runtime retry suppression.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const REPOSITORY = 'alexj11324/Mikka'
const WORKFLOW = '.github/workflows/e2b-official-runtime.yml'
const FAILURE_STEPS = new Set([
  'Build private versioned candidates and require official file conservation',
  'Require real Claude Code and Codex subscriptions on the private candidates',
])
const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0

/** Hash the committed Git entries, including paths and modes. Read the filter
 * from this commit's workflow so additions to runtime_paths cannot drift away
 * from the fingerprint. Only the workflow's deliberately simple quoted list is
 * supported; a new syntax must be handled explicitly rather than under-hashed. */
export function runtimeInputsDigest({ ref, cwd = process.cwd() }) {
  if (!/^[a-f0-9]{40}$/.test(ref ?? '')) throw Error('runtimeInputs:commitRequired')
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const workflow = git(['show', `${ref}:${WORKFLOW}`])
  const block = workflow.split('    paths: &runtime_paths\n')[1]?.split(/\n  [^ ]/)[0]
  if (!block) throw Error('runtimeInputs:pathsRequired')
  const patterns = block.split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
    const match = /^      - '([^']+)'$/.exec(line)
    if (!match) throw Error('runtimeInputs:unsupportedPathFilter')
    const pattern = match[1].split(/(\*\*|\*)/).map(part => part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
    return new RegExp(`^${pattern}$`)
  })
  const entries = git(['ls-tree', '-rz', '--full-tree', ref]).split('\0').filter(Boolean).filter(entry => {
    const path = entry.slice(entry.indexOf('\t') + 1)
    return patterns.some(pattern => pattern.test(path))
  })
  if (!entries.length) throw Error('runtimeInputs:emptyInputs')
  return createHash('sha256').update('mikka-runtime-inputs-v1\0' + entries.join('\0') + '\0').digest('hex')
}

export function releaseDecision({ wanted, live, refresh = false, failedRunId, eventName, reason }) {
  if (eventName === 'workflow_dispatch') {
    if (!reason?.trim()) throw Error('runtimeInputs:retryReasonRequired')
    return { changed: true, reason: 'manual retry' }
  }
  if (wanted === live && !refresh) return { changed: false, reason: 'worker already published' }
  if (failedRunId) return { changed: false, reason: `skipped: same inputs as failed run ${failedRunId}` }
  return { changed: true, reason: refresh ? 'runtime release controls changed' : 'worker differs' }
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
  if (!/^[a-f0-9]{64}$/.test(digest ?? '')) throw Error('runtimeInputs:digestRequired')
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
    const failedRunId = manual ? null : await findFailedInputs({ digest, currentRunId: process.env.GITHUB_RUN_ID, token: process.env.GITHUB_TOKEN })
    const reason = manual ? 'manual retry; failed-input skip bypassed'
      : failedRunId ? `skipped: same inputs as failed run ${failedRunId}` : 'no matching failed runtime inputs'
    console.log(`Runtime inputs ${digest}: ${reason}`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `digest=${digest}\nskip=${Boolean(failedRunId)}\n`)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nRuntime inputs: \`${digest}\`\n\n${reason}\n`)
      if (manual) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\nManual retry reason:\n<pre>'
        + process.env.RETRY_REASON.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</pre>\n')
    }
  }
}
