// Release evidence for the Web Cloudflare serves: GitHub reads, the current-main fence,
// Desktop source ancestry and the exact-source wait used by acceptance drivers.
import { setTimeout as sleep } from 'node:timers/promises'
import { officialMikkaRepository, publicRepositoryId } from '../cloudflare-source.mjs'

const SHA = /^[a-f0-9]{40}$/
export const PRODUCTION_VERSION_URL = 'https://app.aspectlylabs.com/mikka/api/version'
const WEB_WORKFLOW = '.github/workflows/web-deploy.yml'
const BUILD_STEPS = ['Build (runs migrations last, as the Vercel build did)',
  'Upload the prebuilt output to production', 'Verify the public production version before releasing the deployment queue']

/** Current production deployment's commit, read through the public alias. */
export async function productionSha({ token, fetchImpl = fetch }) {
  const api = path => fetchImpl(`https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=team_C7lwxVVvnUicFli6112mvxpv`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
      .then(response => { if (!response.ok) throw Error(`webDeploy:vercel:${response.status}`); return response.json() })
  const alias = await api('/v4/aliases/app.aspectlylabs.com?projectId=prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH')
  const deployment = await api(`/v13/deployments/${alias.deploymentId}`)
  const sha = deployment.gitSource?.sha ?? deployment.meta?.githubCommitSha
  return SHA.test(sha ?? '') ? sha : ''
}

export async function githubRead(path, { token, fetchImpl, timeoutMs = 20_000 }) {
  if (!token) throw Error('webDeploy:githubTokenRequired')
  let response
  try {
    response = await fetchImpl(`https://api.github.com/repositories/${publicRepositoryId}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))), redirect: 'error', cache: 'no-store',
    })
  } catch { throw Error('webDeploy:githubUnavailable') }
  if (!response.ok) throw Error(`webDeploy:github:${response.status}`)
  try { return await response.json() } catch { throw Error('webDeploy:githubInvalidResponse') }
}

/** A queued older release must never mutate configuration or upload after main advanced. */
export async function assertCurrentMain({ expectedBuild, token, fetchImpl = fetch, timeoutMs }) {
  if (!SHA.test(expectedBuild ?? '')) throw Error('webDeploy:commitShaRequired')
  const ref = await githubRead('/git/ref/heads/main', { token, fetchImpl, timeoutMs })
  if (ref.object?.type !== 'commit' || !SHA.test(ref.object?.sha ?? '')) throw Error('webDeploy:invalidMainRef')
  if (ref.object.sha !== expectedBuild) throw Error(`webDeploy:mainChanged:expected=${expectedBuild}:actual=${ref.object.sha}`)
}

async function publicBuild(fetchImpl, timeoutMs, expectedOverlay) {
  try {
    const response = await fetchImpl(PRODUCTION_VERSION_URL, { cache: 'no-store', headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))), redirect: 'error' })
    if (!response.ok) { await response.body?.cancel(); return null }
    const value = await response.json()
    return SHA.test(value?.build ?? '') && (!expectedOverlay || value.overlaySha === expectedOverlay) ? value.build : null
  } catch {
    return null
  }
}

/** Called again inside the shared publication queue before touching runtime env. */
export async function assertProductionSource({ expectedBuild, token, fetchImpl = fetch }) {
  if (!SHA.test(expectedBuild ?? '')) throw Error('webDeploy:commitShaRequired')
  if (await productionSha({ token, fetchImpl }) !== expectedBuild || await publicBuild(fetchImpl, 10_000) !== expectedBuild) {
    throw Error('production_source_changed')
  }
}


/** The desktop can use a newer deployed backend only when GitHub proves that
 * exact public commit contains the desktop source. Never infer this from dates,
 * branch names or a successful workflow for a different commit. */
export async function containsDesktopSource({ expectedBuild, publicCommit, token, fetchImpl, timeoutMs }) {
  if (publicCommit === expectedBuild) return true
  const path = `/compare/${expectedBuild}...${publicCommit}`
  const comparison = await githubRead(path + '?per_page=1', { token, fetchImpl, timeoutMs })
  if (!['alexj11324/Mikka', 'aspectly-labs/Mikka'].some(repository =>
    comparison.url === `https://api.github.com/repos/${repository}${path}`)
    || comparison.base_commit?.sha !== expectedBuild || !SHA.test(comparison.merge_base_commit?.sha ?? '')
    || !['ahead', 'behind', 'diverged', 'identical'].includes(comparison.status)
    || !Number.isSafeInteger(comparison.ahead_by) || comparison.ahead_by < 0
    || !Number.isSafeInteger(comparison.behind_by) || comparison.behind_by < 0) {
    throw Error('webDeploy:invalidCommitComparison')
  }
  return comparison.status === 'ahead' && comparison.ahead_by > 0 && comparison.behind_by === 0
    && comparison.merge_base_commit.sha === expectedBuild
}

/** This read-only wait runs OUTSIDE web-deploy-production: GitHub can still be
 * building while Vercel only knows the previous READY deployment. A successful
 * docs-only workflow is not a successful application build. */
export async function waitForWebDeployment({ expectedBuild, expectedOverlay, token, fetchImpl = fetch, maxWaitMs = 40 * 60_000,
  intervalMs = 10_000, now = () => performance.now(), wait = sleep }) {
  if (!SHA.test(expectedBuild ?? '')) throw Error('webDeploy:commitShaRequired')
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) throw Error('webDeploy:invalidVerificationWait')
  if (!token) throw Error('webDeploy:githubTokenRequired')
  if (expectedOverlay && !SHA.test(expectedOverlay)) throw Error('webDeploy:overlayShaRequired')
  const started = now(), remaining = () => maxWaitMs - (now() - started)
  let checkedPublisher = false
  while (remaining() > 0) {
    const webBuild = expectedBuild
    await assertCurrentMain({ expectedBuild, token, fetchImpl, timeoutMs: Math.min(20_000, remaining()) })
    if (remaining() <= 0) break
    const data = await githubRead(`/actions/workflows/web-deploy.yml/runs?head_sha=${webBuild}&branch=main&per_page=100`,
      { token, fetchImpl, timeoutMs: Math.min(20_000, remaining()) })
    const runs = (data.workflow_runs ?? []).filter(run => run.head_sha === webBuild && run.head_branch === 'main'
      && run.path === WEB_WORKFLOW && [run.repository, run.head_repository].every(repository => officialMikkaRepository(repository?.full_name,
        String(repository?.id), repository?.owner?.id === undefined ? undefined : String(repository.owner.id)))
      && ['push', 'workflow_dispatch'].includes(run.event)).sort((a, b) => b.id - a.id)
    const run = runs[0]
    if (!run && !checkedPublisher) {
      const publisher = await githubRead('/actions/workflows/web-deploy.yml', {
        token, fetchImpl, timeoutMs: Math.min(20_000, remaining()),
      })
      if (publisher.path !== WEB_WORKFLOW || typeof publisher.state !== 'string') throw Error('webDeploy:invalidWebPublisher')
      if (publisher.state !== 'active') throw Error('webDeploy:matchingWebPublisherInactive')
      checkedPublisher = true
    }
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw Error(`webDeploy:matchingWebRunFailed:${run.id}`)
      if (!Number.isSafeInteger(run.id) || run.id <= 0 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) {
        throw Error('webDeploy:invalidWebRun')
      }
      if (remaining() <= 0) break
      const jobs = await githubRead(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
        { token, fetchImpl, timeoutMs: Math.min(20_000, remaining()) })
      const builds = (jobs.jobs ?? []).filter(job => job.name === 'deploy' && job.head_sha === webBuild)
      const job = builds[0]
      if (jobs.total_count !== jobs.jobs?.length || builds.length !== 1 || job.status !== 'completed' || job.conclusion !== 'success') {
        throw Error('webDeploy:matchingWebBuildSkippedOrIncomplete')
      }
      const required = BUILD_STEPS.map(name => Array.isArray(job.steps) ? job.steps.filter(step => step.name === name) : [])
      if (required.some(steps => steps.length !== 1)) throw Error('webDeploy:matchingWebBuildSkippedOrIncomplete')
      const steps = required.map(([step]) => step)
      if (!steps.every(step => step.status === 'completed' && step.conclusion === 'success')) {
        // GitHub can finish a job before its step list catches up. Only pending
        // results may wait; skipped, failed, missing or duplicate proof refuses.
        if (!steps.every(step => step.status === 'completed' ? step.conclusion === 'success'
          : ['queued', 'pending', 'in_progress'].includes(step.status) && step.conclusion === null)) {
          throw Error('webDeploy:matchingWebBuildSkippedOrIncomplete')
        }
        if (remaining() > 0) await wait(Math.min(intervalMs, remaining()))
        continue
      }
      if (remaining() <= 0) break
      if (await publicBuild(fetchImpl, Math.min(10_000, remaining()), expectedOverlay) === webBuild && remaining() > 0) {
        await assertCurrentMain({ expectedBuild, token, fetchImpl, timeoutMs: Math.min(20_000, remaining()) })
        if (remaining() > 0) return { sourceCommit: expectedBuild, webRunId: run.id, webAttempt: run.run_attempt,
          publicBuild: webBuild, verifiedAt: new Date().toISOString() }
      }
    }
    if (remaining() > 0) await wait(Math.min(intervalMs, remaining()))
  }
  throw Error('webDeploy:matchingWebDeploymentTimedOut')
}
