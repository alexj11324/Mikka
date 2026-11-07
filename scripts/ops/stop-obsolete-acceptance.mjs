import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const REPO = 'alexj11324/Mikka'
const API = 'https://api.github.com/repos/' + REPO
const BRANCH = 'refs/heads/ops/issue1415-stop-obsolete-acceptance'
export const BINDING = Object.freeze({ runId: 42326864360, headSha: '837b96a69d038b5db92a24cf2a1fad884e37d3ce' })
class ClosedError extends Error { constructor(code) { super(code); this.code = code } }
function need(v, code) { if (!v) throw new ClosedError(code) }
const started = step => ['in_progress', 'completed'].includes(step.status) && step.conclusion !== 'skipped'
export function validateRun(run, binding) {
  need(Number.isSafeInteger(binding?.runId) && binding.runId > 0 && /^[a-f0-9]{40}$/.test(binding.headSha ?? ''), 'UNBOUND')
  need(run?.id === binding.runId && run.workflow_id === 408169403 && run.run_attempt === 1
    && run.path === '.github/workflows/read-cache-production.yml' && run.event === 'workflow_run'
    && run.head_branch === 'main' && run.head_sha === binding.headSha
    && run.repository?.id === 1427517699 && run.repository.full_name === REPO && run.repository.owner?.id === 183887963
    && run.head_repository?.id === 1427517699 && run.head_repository.full_name === REPO, 'TARGET_MISMATCH')
  need(['queued', 'in_progress', 'pending', 'waiting', 'requested', 'completed'].includes(run.status), 'STATUS_INVALID')
}
export function validateJobs(payload) {
  need(Number.isSafeInteger(payload?.total_count) && Array.isArray(payload.jobs) && payload.total_count === payload.jobs.length
    && payload.jobs.length <= 20, 'JOBS_INCOMPLETE')
  for (const job of payload.jobs) {
    need(Array.isArray(job.steps), 'JOBS_INCOMPLETE')
    need(!job.steps.some(step => started(step) && [
      'Read the existing smoke email only', 'Read the existing smoke password only',
      'Measure existing chat, tasks, activity and Settings reads',
      'Verify the normal smoke-owner browser home and computer tab',
      'Prove one normal-owner Coordinator turn and its once-only due reminder',
    ].includes(step.name)), 'OWNER_STAGE_ALREADY_STARTED')
  }
}
export async function requestCancellation({ binding = BINDING, env = process.env, fetchImpl = fetch } = {}) {
  const report = { kind: 'issue1415-obsolete-acceptance-cancel', targetRunId: binding?.runId ?? null,
    targetHeadSha: binding?.headSha ?? null, result: 'blocked', code: null, postAttempted: false,
    httpStatus: null, businessExecutionVerified: false, ownerRequestsByController: 0, modelCallsByController: 0 }
  try {
    need(Number.isSafeInteger(binding?.runId) && binding.runId > 0 && /^[a-f0-9]{40}$/.test(binding.headSha ?? ''), 'UNBOUND')
    need(env.GITHUB_REPOSITORY === REPO && env.GITHUB_REPOSITORY_ID === '1427517699'
      && env.GITHUB_REPOSITORY_OWNER_ID === '183887963' && env.GITHUB_EVENT_NAME === 'push'
      && env.GITHUB_REF === BRANCH && env.GITHUB_RUN_ATTEMPT === '1'
      && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '')
      && typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'CONTEXT_REJECTED')
    const headers = { accept: 'application/vnd.github+json', authorization: 'Bearer ' + env.GH_TOKEN,
      'X-GitHub-Api-Version': '2026-03-10' }
    const runUrl = API + '/actions/runs/' + binding.runId
    async function read(url) {
      const r = await fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000) })
      need(r.status === 200 && !r.redirected && (!r.url || r.url === url), 'READ_FAILED')
      const text = await r.text(); need(Buffer.byteLength(text) <= 131072, 'READ_TOO_LARGE')
      return JSON.parse(text)
    }
    for (let pass = 0; pass < 2; pass++) {
      const run = await read(runUrl); validateRun(run, binding)
      if (run.status === 'completed') { report.result = 'already_completed'; report.code = 'NO_CANCEL_NEEDED'; return report }
      validateJobs(await read(runUrl + '/jobs?per_page=100'))
    }
    report.postAttempted = true
    const r = await fetchImpl(runUrl + '/cancel', { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(15000) })
    report.httpStatus = r.status
    try { await r.body?.cancel() } catch {}
    need(r.status === 202 && !r.redirected && (!r.url || r.url === runUrl + '/cancel'), 'CANCEL_NOT_ACCEPTED')
    report.result = 'cancel_requested'; report.code = 'CANCEL_ACCEPTED'
  } catch (e) {
    report.code = e instanceof ClosedError ? e.code : 'REQUEST_UNCERTAIN'
    if (report.postAttempted) report.result = 'request_uncertain'
  }
  return report
}
async function main() {
  need(process.argv.length === 2, 'ARGUMENTS_REJECTED')
  const report = await requestCancellation()
  await mkdir('obsolete-acceptance-cancel-report', { recursive: true, mode: 0o700 })
  await writeFile('obsolete-acceptance-cancel-report/result.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(report))
  if (!['cancel_requested', 'already_completed'].includes(report.result)) process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('{"code":"CONTROLLER_FAILURE"}'); process.exitCode = 1 })
}
