/** Main-only, explicitly selected product acceptance. The existing GitHub
 * token verifies release evidence before either shared-account credential is
 * read. This mode does not need a database, provider or fixture Secret.
 */
import { resolve } from 'node:path'
import { attestAcceptance, assertArtifactIdentity, downloadReleaseReport, releasePins } from './task-secrets-ci.mjs'
import { assertReleaseIdentity, selectRelease, REPOSITORY } from './thread-lifecycle-ci.mjs'

const SHA = /^[a-f0-9]{40}$/
const positive = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))
const check = value => { if (!value) throw Error('workspace_review_guard_refused') }

export function readWorkspaceReviewOptions(args, env = process.env) {
  check(args.length === 1 && ['--execute', '--cleanup'].includes(args[0]))
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.ACCEPTANCE_MODE === 'workspace-review'
    && env.TASK_SECRETS_MODEL_CASE === 'all' && env.PRODUCTION_CANARY === 'false'
    && env.FACTORY_ACCEPTANCE_REQUESTED === 'false' && !env.TASK_SECRETS_WINDOW
    && positive(env.GITHUB_RUN_ID) && positive(env.GITHUB_RUN_ATTEMPT))
  check(SHA.test(env.APPLICATION_SHA ?? '') && env.APPLICATION_SHA === env.EXPECTED_SOURCE_SHA
    && env.APPLICATION_SHA === env.GITHUB_SHA && SHA.test(env.EXPECTED_WORKER_SHA ?? '')
    && SHA.test(env.EXPECTED_WORKER_SOURCE_SHA ?? '')
    && positive(env.WORKSPACE_REVIEW_RELEASE_RUN_ID) && positive(env.WORKSPACE_REVIEW_RELEASE_RUN_ATTEMPT))
  const templates = { claude_code: env.EXPECTED_CLAUDE_TEMPLATE, codex: env.EXPECTED_CODEX_TEMPLATE }
  check(Object.values(templates).every(value => /^[A-Za-z0-9_-]{1,128}$/.test(value ?? ''))
    && templates.claude_code !== templates.codex)
  return Object.freeze({ cleanupOnly: args[0] === '--cleanup', sourceCommit: env.APPLICATION_SHA,
    workerSha: env.EXPECTED_WORKER_SHA, workerSourceCommit: env.EXPECTED_WORKER_SOURCE_SHA, templates,
    releaseRunId: Number(env.WORKSPACE_REVIEW_RELEASE_RUN_ID), releaseRunAttempt: Number(env.WORKSPACE_REVIEW_RELEASE_RUN_ATTEMPT),
    driver: { runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT) },
    timeoutMs: 480000, reportPath: resolve('production-coding-workspace-report/report.json') })
}

export async function attestCodingWorkspace(env = process.env, { fetchImpl = fetch, attest = attestAcceptance,
  download = downloadReleaseReport, now = Date.now } = {}) {
  const options = readWorkspaceReviewOptions(['--execute'], env)
  check(typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0)
  const application = await attest(env, { fetchImpl })
  check(application?.sourceCommit === options.sourceCommit && application.publicBuild === options.sourceCommit)
  const read = async path => {
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + env.GITHUB_TOKEN,
        'x-github-api-version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(20000) })
    check(response.ok); return response.json()
  }
  const [workflow, run] = await Promise.all([
    read('/actions/workflows/e2b-official-runtime.yml'), read(`/actions/runs/${options.releaseRunId}`),
  ])
  const expected = { sourceCommit: options.workerSourceCommit, runId: options.releaseRunId,
    runAttempt: options.releaseRunAttempt, workflowId: workflow.id, event: run.event }
  assertReleaseIdentity(expected, workflow, run)
  const jobs = await read(`/actions/runs/${expected.runId}/attempts/${expected.runAttempt}/jobs?per_page=100`)
  const selection = selectRelease(expected, jobs, [])
  check(selection.runtime === 'validated_and_published' && selection.selected === true)
  const listing = await read(`/actions/runs/${expected.runId}/artifacts?per_page=100`)
  check(Array.isArray(listing?.artifacts) && listing.total_count === listing.artifacts.length && listing.total_count <= 100)
  const matches = listing.artifacts.filter(item => item.name === `e2b-release-evidence-${expected.runId}-${expected.runAttempt}`)
  check(matches.length === 1)
  const listed = assertArtifactIdentity(expected, run, matches[0], now())
  const artifact = assertArtifactIdentity(expected, run, await read(`/actions/artifacts/${listed.id}`), now())
  check(JSON.stringify(artifact) === JSON.stringify(listed))
  const pins = releasePins(await download({ selected: true, artifact }, { token: env.GITHUB_TOKEN, fetchImpl }), expected, options.workerSha)
  check(pins.workerSourceCommit === options.workerSourceCommit && pins.templates.claude_code === options.templates.claude_code
    && pins.templates.codex === options.templates.codex)
  // An upstream rerun or artifact replacement invalidates this selection.
  assertReleaseIdentity(expected, workflow, await read(`/actions/runs/${expected.runId}`))
  check(JSON.stringify(assertArtifactIdentity(expected, run, await read(`/actions/artifacts/${artifact.id}`), now())) === JSON.stringify(artifact))
  const final = await attest(env, { fetchImpl })
  check(final.sourceCommit === options.sourceCommit && final.publicBuild === options.sourceCommit)
  return { kind: 'coding-workspace-release-attestation', sourceCommit: options.sourceCommit, publicBuild: options.sourceCommit,
    upstream: { runId: expected.runId, runAttempt: expected.runAttempt, workflowId: expected.workflowId },
    driver: options.driver, ...pins, artifact, runtime: selection.runtime }
}
