import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

// These workflows run for every main push. The SSH/vault PR-only workflows
// cannot provide a push run for the merge SHA and must not deadlock release.
export const RELEASE_WORKFLOWS = ['ui-policy.yml', 'browser-tests.yml']
const SHA = /^[a-f0-9]{40}$/
const REPOSITORY = 'alexj11324/Mikka'

/** A merge to main is the existing release authority. A PR run is never a release credential. */
export function releaseIdentity(env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== 'refs/heads/main' ||
      !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || !SHA.test(env.GITHUB_SHA ?? '') ||
      !/^\d+$/.test(env.GITHUB_RUN_ID ?? '')) throw Error('releaseMainIdentityRequired')
  return { repository: REPOSITORY, sha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, kind: 'github-actions-main' }
}

export function checkWorkflowRuns(identity, workflow, runs) {
  const relevant = runs.filter(run => run.head_sha === identity.sha && run.event === 'push' &&
    run.head_branch === 'main' && run.repository?.full_name === identity.repository &&
    run.path === `.github/workflows/${workflow}`)
  const latest = relevant.sort((a, b) => b.id - a.id)[0]
  if (!latest || latest.status !== 'completed') return { workflow, state: 'pending' }
  if (latest.conclusion !== 'success') throw Error(`releaseCheckFailed:${workflow}`)
  return { workflow, state: 'success', runId: latest.id }
}

export async function waitForReleaseChecks(identity, { token, fetchImpl = fetch, wait = delay,
  timeoutMs = 20 * 60_000, intervalMs = 15_000, now = Date.now } = {}) {
  if (!token) throw Error('releaseChecksTokenRequired')
  const deadline = now() + timeoutMs
  for (;;) {
    const checks = await Promise.all(RELEASE_WORKFLOWS.map(async workflow => {
      const url = new URL(`https://api.github.com/repos/${identity.repository}/actions/workflows/${workflow}/runs`)
      url.search = new URLSearchParams({ head_sha: identity.sha, event: 'push', branch: 'main', per_page: '100' }).toString()
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) { await response.body?.cancel(); throw Error(`releaseChecksUnavailable:${workflow}`) }
      const data = await response.json()
      if (!Array.isArray(data.workflow_runs)) throw Error('releaseCheckResponseInvalid')
      return checkWorkflowRuns(identity, workflow, data.workflow_runs)
    }))
    if (checks.every(check => check.state === 'success')) return checks
    if (now() >= deadline) throw Error('releaseChecksIncomplete')
    await wait(Math.min(intervalMs, deadline - now()))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const identity = releaseIdentity(process.env)
  const checks = await waitForReleaseChecks(identity, { token: process.env.GITHUB_TOKEN })
  console.log(JSON.stringify({ sourceSha: identity.sha, checks }))
}
