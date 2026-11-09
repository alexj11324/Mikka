// Production web build on GitHub Actions (docs/operations/web-deploy.md).
// `vercel pull` writes the production environment to .vercel/.env.production.local,
// but Vercel returns "sensitive" variables empty. The job reads prod:/vercel from
// Infisical (the source Vercel production is synced from) and this fills every
// pulled key that came back empty, so the build sees what a Vercel build saw. It
// also pins the Git identity the migration guard checks and refuses to build
// with a required value missing. The deployment's runtime environment still
// comes from the Vercel project; nothing here is uploaded as configuration.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import { shouldSkip } from '../vercel-ignore-build.mjs'

/** Must be non-empty in the final build environment: inlined client keys, the migration targets, the worker build. */
export const REQUIRED = ['MIKKA_DATABASE_URL', 'DATABASE_URL', 'NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'MIKKA_BUILD_BYOS_WORKER', 'NEXT_PUBLIC_COMPUTER_ENABLED']

const LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const SHA = /^[a-f0-9]{40}$/
export const PRODUCTION_VERSION_URL = 'https://app.aspectlylabs.com/mikka/api/version'
const REPOSITORY = 'alexj11324/Mikka'
const WEB_WORKFLOW = '.github/workflows/web-deploy.yml'
const BUILD_STEPS = ['Build (runs migrations last, as the Vercel build did)',
  'Upload the prebuilt output to production', 'Verify the public production version before releasing the deployment queue']
export const RUNTIME_RELEASE_PATHS = ['.github/workflows/e2b-official-runtime.yml', '.github/workflows/e2b-template.yml', '.github/workflows/web-deploy.yml',
  'scripts/e2b/validate-template-subscriptions.mjs', 'scripts/e2b/cleanup-template-candidates.py',
  'scripts/e2b/runtime-report.mjs', 'scripts/e2b/acceptance-daemon.mts', 'scripts/e2b/acceptance-bootstrap.mts',
  'lib/captures/bootstrap-evidence.ts', 'app/api/runs/[runId]/evidence/route.ts',
  'lib/computer/claude-startup-hint.ts', 'lib/computer/codex-startup-hint.ts',
  'scripts/acceptance/cloud-startup.mjs', 'scripts/acceptance/cloud-startup-evidence.mjs',
  'scripts/acceptance/team-workspace.mjs', 'lib/smoke-account.ts',
  'scripts/e2b/publish-template-env.mjs', 'scripts/release/web-deploy.mjs', 'scripts/release/build-vercel.mjs']

function parse(text) {
  const entries = new Map()
  for (const line of text.split('\n')) {
    const match = LINE.exec(line)
    if (!match) continue
    const raw = match[2].trim()
    let value = raw
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      try { value = JSON.parse(raw) } catch { value = raw.slice(1, -1) }
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) value = raw.slice(1, -1)
    entries.set(match[1], value)
  }
  return entries
}

/** Resolves production values; throws with variable names only, never values. */
export function buildEnvironmentValues(text, job) {
  if (!SHA.test(job.GITHUB_SHA ?? '')) throw Error('webDeploy:commitShaRequired')
  const entries = parse(text)
  // Only keys the production environment defines, and only where Vercel withheld the value.
  for (const [key, value] of entries) if (!value && job[key]) entries.set(key, job[key])
  entries.set('VERCEL_GIT_PROVIDER', 'github')
  entries.set('VERCEL_GIT_REPO_OWNER', 'alexj11324')
  entries.set('VERCEL_GIT_REPO_SLUG', 'Mikka')
  entries.set('VERCEL_GIT_COMMIT_REF', 'main')
  entries.set('VERCEL_GIT_COMMIT_SHA', job.GITHUB_SHA)
  if (entries.get('VERCEL_ENV') !== 'production') throw Error('webDeploy:productionEnvironmentRequired')
  const missing = REQUIRED.filter(key => !entries.get(key))
  if (missing.length) throw Error(`webDeploy:missing:${missing.join(',')}`)
  return Object.fromEntries(entries)
}

/** The build file uses JSON string values; the direct build reuses the object
 * above rather than interpreting those escapes with a different dotenv parser. */
export function buildEnvironment(text, job) {
  return Object.entries(buildEnvironmentValues(text, job))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n'
}

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

async function githubRead(path, { token, fetchImpl, timeoutMs = 20_000 }) {
  if (!token) throw Error('webDeploy:githubTokenRequired')
  let response
  try {
    response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}${path}`, {
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
  } catch { return null }
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
async function containsDesktopSource({ expectedBuild, publicCommit, token, fetchImpl, timeoutMs }) {
  if (publicCommit === expectedBuild) return true
  const path = `/compare/${expectedBuild}...${publicCommit}`
  const comparison = await githubRead(path + '?per_page=1', { token, fetchImpl, timeoutMs })
  if (comparison.url !== `https://api.github.com/repos/${REPOSITORY}${path}`
    || comparison.base_commit?.sha !== expectedBuild || !SHA.test(comparison.merge_base_commit?.sha ?? '')
    || !['ahead', 'behind', 'diverged', 'identical'].includes(comparison.status)
    || !Number.isSafeInteger(comparison.ahead_by) || comparison.ahead_by < 0
    || !Number.isSafeInteger(comparison.behind_by) || comparison.behind_by < 0) {
    throw Error('webDeploy:invalidCommitComparison')
  }
  return comparison.status === 'ahead' && comparison.ahead_by > 0 && comparison.behind_by === 0
    && comparison.merge_base_commit.sha === expectedBuild
}

/** Keep the runtime's queued Web wait separate from Desktop and direct callers. */
export function webDeploymentWaitOptions(command) {
  return {
    allowDescendant: command === 'await-desktop-web',
    maxWaitMs: (command === 'await-web' ? 90 : 40) * 60_000,
  }
}

/** This read-only wait runs OUTSIDE web-deploy-production: GitHub can still be
 * building while Vercel only knows the previous READY deployment. A successful
 * docs-only workflow is not a successful application build. */
export async function waitForWebDeployment({ expectedBuild, allowDescendant = false, expectedOverlay, token, fetchImpl = fetch, maxWaitMs = 40 * 60_000,
  intervalMs = 10_000, now = () => performance.now(), wait = sleep }) {
  if (!SHA.test(expectedBuild ?? '')) throw Error('webDeploy:commitShaRequired')
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) throw Error('webDeploy:invalidVerificationWait')
  if (!token) throw Error('webDeploy:githubTokenRequired')
  if (expectedOverlay && !SHA.test(expectedOverlay)) throw Error('webDeploy:overlayShaRequired')
  const started = now(), remaining = () => maxWaitMs - (now() - started)
  while (remaining() > 0) {
    let webBuild = expectedBuild
    if (allowDescendant === true) {
      // The live public build is the candidate, not whichever main head happens
      // to exist while signing. A newer docs-only main does not need a Web build.
      webBuild = await publicBuild(fetchImpl, Math.min(10_000, remaining()), expectedOverlay)
      if (remaining() <= 0) break
      if (!webBuild || !await containsDesktopSource({ expectedBuild, publicCommit: webBuild,
        token, fetchImpl, timeoutMs: Math.min(20_000, remaining()) })) {
        if (remaining() > 0) await wait(Math.min(intervalMs, remaining()))
        continue
      }
    } else {
      // Web/runtime mutation callers retain the original exact-main fence.
      await assertCurrentMain({ expectedBuild, token, fetchImpl, timeoutMs: Math.min(20_000, remaining()) })
    }
    if (remaining() <= 0) break
    const data = await githubRead(`/actions/workflows/web-deploy.yml/runs?head_sha=${webBuild}&branch=main&per_page=100`,
      { token, fetchImpl, timeoutMs: Math.min(20_000, remaining()) })
    const runs = (data.workflow_runs ?? []).filter(run => run.head_sha === webBuild && run.head_branch === 'main'
      && run.path === WEB_WORKFLOW && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY
      && ['push', 'workflow_dispatch'].includes(run.event)).sort((a, b) => b.id - a.id)
    const run = runs[0]
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
        if (allowDescendant !== true) await assertCurrentMain({ expectedBuild, token, fetchImpl, timeoutMs: Math.min(20_000, remaining()) })
        if (remaining() > 0) return { sourceCommit: expectedBuild, webRunId: run.id, webAttempt: run.run_attempt,
          publicBuild: webBuild, verifiedAt: new Date().toISOString() }
      }
    }
    if (remaining() > 0) await wait(Math.min(intervalMs, remaining()))
  }
  throw Error('webDeploy:matchingWebDeploymentTimedOut')
}

export async function deploymentPlan({ expectedBuild, runtimeRefresh = false, token, fetchImpl = fetch, classify = shouldSkip }) {
  if (!SHA.test(expectedBuild ?? '')) throw Error('webDeploy:commitShaRequired')
  // A prior attempt may have written env and then failed its build. The explicit
  // refresh reuses the validated runtime pair and must still build that source.
  if (runtimeRefresh) return { skip: false, reason: 'verified runtime refresh' }
  const previous = await productionSha({ token, fetchImpl })
  return classify({ VERCEL_ENV: 'production', VERCEL_GIT_PREVIOUS_SHA: previous, VERCEL_GIT_COMMIT_SHA: expectedBuild })
}

/** Publication-control edits need their own real release validation even though
 * they intentionally do not alter the daemon's content hash. Compare the entire
 * push, never just HEAD's parent. Missing history is an error, not "unchanged". */
export function runtimeRefreshRequired({ expectedBuild, eventName, event, explicit = false }, diff = (before, after) =>
  execFileSync('git', ['diff', '--name-only', '--no-renames', before, after, '--', ...RUNTIME_RELEASE_PATHS], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean)) {
  if (!SHA.test(expectedBuild ?? '')) throw Error('webDeploy:commitShaRequired')
  if (eventName !== 'push') return eventName === 'workflow_dispatch' && explicit === true
  if (!SHA.test(event?.before ?? '') || /^0+$/.test(event.before) || event.after !== expectedBuild || event.ref !== 'refs/heads/main') {
    throw Error('webDeploy:invalidPushSource')
  }
  let files
  try { files = diff(event.before, expectedBuild) } catch { throw Error('webDeploy:releaseControlDiffUnavailable') }
  if (!Array.isArray(files) || !files.every(path => typeof path === 'string')) throw Error('webDeploy:releaseControlDiffUnavailable')
  return files.some(path => RUNTIME_RELEASE_PATHS.includes(path))
}

/** Verify the public application while this job still owns the deployment
 * queue. Deployment metadata alone does not prove what the public route serves. */
export async function verifyProductionBuild({ expectedBuild, fetchImpl = fetch, maxWaitMs = 120_000,
  intervalMs = 2_000, now = () => performance.now(), wait = sleep }) {
  if (!SHA.test(expectedBuild ?? '')) throw Error('webDeploy:commitShaRequired')
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw Error('webDeploy:invalidVerificationWait')
  }
  const started = now()
  let status = 'unavailable', build = 'unavailable', attempts = 0
  while (now() - started < maxWaitMs) {
    attempts++
    try {
      const remaining = maxWaitMs - (now() - started)
      if (remaining <= 0) break
      const response = await fetchImpl(PRODUCTION_VERSION_URL, {
        cache: 'no-store', headers: { 'cache-control': 'no-cache' },
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, Math.ceil(remaining)))),
      })
      status = String(response.status)
      build = 'unavailable'
      if (response.ok) {
        const value = await response.json()
        build = SHA.test(value?.build ?? '') ? value.build : 'invalid'
        if (build === expectedBuild && now() - started < maxWaitMs) return { url: PRODUCTION_VERSION_URL, build, status: response.status,
          verifiedAt: new Date().toISOString(), attempts }
      } else await response.body?.cancel()
    } catch {
      // Public error bodies and transport messages are not deployment evidence.
      status = 'unavailable'; build = 'unavailable'
    }
    const remaining = maxWaitMs - (now() - started)
    if (remaining > 0) await wait(Math.min(intervalMs, remaining))
  }
  throw Error(`webDeploy:productionVersionUnverified:expected=${expectedBuild}:status=${status}:build=${build}:attempts=${attempts}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, file] = process.argv.slice(2)
  if (command === 'env') {
    writeFileSync(file, buildEnvironment(readFileSync(file, 'utf8'), process.env), { mode: 0o600 })
    console.log('Build environment ready')
  } else if (command === 'skip') {
    // Same documentation-only rule Vercel's Ignored Build Step used, against what production serves now.
    const { skip, reason } = await deploymentPlan({ expectedBuild: process.env.GITHUB_SHA, token: process.env.VERCEL_TOKEN,
      runtimeRefresh: process.env.RUNTIME_REFRESH === 'true' })
    console.log(`${skip ? 'Skipping' : 'Building'}: ${reason}`)
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `skip=${skip}\n`, { flag: 'a' })
  } else if (command === 'main') {
    await assertCurrentMain({ expectedBuild: process.env.GITHUB_SHA, token: process.env.GITHUB_TOKEN })
    console.log('Current main matches this release')
  } else if (command === 'runtime-refresh') {
    let event
    if (process.env.GITHUB_EVENT_NAME === 'push') {
      try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) } catch { throw Error('webDeploy:invalidPushEvent') }
    }
    const refresh = runtimeRefreshRequired({ expectedBuild: process.env.GITHUB_SHA, eventName: process.env.GITHUB_EVENT_NAME,
      event, explicit: process.env.RUNTIME_REFRESH === 'true' })
    console.log(`Runtime release control refresh: ${refresh}`)
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `refresh=${refresh}\n`, { flag: 'a' })
  } else if (command === 'await-web' || command === 'await-desktop-web') {
    const result = await waitForWebDeployment({ expectedBuild: process.env.GITHUB_SHA,
      ...webDeploymentWaitOptions(command),
      expectedOverlay: process.env.EXPECTED_UI_OVERLAY_SHA || (command === 'await-desktop-web' ? process.env.MIKKA_UI_OVERLAY_SHA : undefined), token: process.env.GITHUB_TOKEN })
    console.log(JSON.stringify({ event: 'matching_web_deployment_verified', ...result }))
  } else if (command === 'verify') {
    const result = await verifyProductionBuild({ expectedBuild: process.env.GITHUB_SHA })
    console.log(JSON.stringify({ event: 'production_version_verified', ...result }))
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY,
      `\n### Public production version verified\n${result.url}\n\nBuild: \`${result.build}\`\n\nUTC: ${result.verifiedAt}\n`, { flag: 'a' })
  } else throw Error('usage: web-deploy.mjs env <file> | skip | main | runtime-refresh | await-web | await-desktop-web | verify')
}
