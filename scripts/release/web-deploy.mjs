// Release evidence for the Web Cloudflare serves: GitHub reads, the current-main fence,
// Desktop source ancestry and the exact-source wait used by acceptance drivers.
import { setTimeout as sleep } from 'node:timers/promises'
import { officialMikkaRepository, publicRepositoryId } from '../cloudflare-source.mjs'

const SHA = /^[a-f0-9]{40}$/
export const PRODUCTION_VERSION_URL = 'https://app.aspectlylabs.com/mikka/api/version'
const REPOSITORY = 'alexj11324/Mikka'

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
    if (!response.ok || !response.headers.has('cf-ray') || response.headers.has('x-vercel-id')) { await response.body?.cancel(); return null }
    const value = await response.json()
    return SHA.test(value?.build ?? '') && (!expectedOverlay || value.overlaySha === expectedOverlay) ? value.build : null
  } catch {
    return null
  }
}

/** Confirm the Cloudflare-served application is the exact source before publishing runtime env. */
export async function assertProductionSource({ expectedBuild, fetchImpl = fetch }) {
  if (!SHA.test(expectedBuild ?? '')) throw Error('webDeploy:commitShaRequired')
  if (await publicBuild(fetchImpl, 10_000) !== expectedBuild) throw Error('production_source_changed')
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

/** Wait for the exact Cloudflare-served build used by production acceptance.
 * The app version endpoint proves the source actually serving; GitHub's main
 * fence prevents accepting a build after source has advanced. */
export async function waitForWebDeployment({ expectedBuild, expectedOverlay, token, fetchImpl = fetch, maxWaitMs = 40 * 60_000,
  intervalMs = 10_000, now = () => performance.now(), wait = sleep }) {
  if (!SHA.test(expectedBuild ?? '')) throw Error('webDeploy:commitShaRequired')
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) throw Error('webDeploy:invalidVerificationWait')
  if (!token) throw Error('webDeploy:githubTokenRequired')
  if (expectedOverlay && !SHA.test(expectedOverlay)) throw Error('webDeploy:overlayShaRequired')
  const started = now(), remaining = () => maxWaitMs - (now() - started)
  while (remaining() > 0) {
    await assertCurrentMain({ expectedBuild, token, fetchImpl, timeoutMs: Math.min(20_000, remaining()) })
    if (remaining() <= 0) break
    const publicBuildSha = await publicBuild(fetchImpl, Math.min(10_000, remaining()), expectedOverlay)
    if (publicBuildSha === expectedBuild && remaining() > 0) {
      await assertCurrentMain({ expectedBuild, token, fetchImpl, timeoutMs: Math.min(20_000, remaining()) })
      if (remaining() > 0) return { sourceCommit: expectedBuild, publicBuild: publicBuildSha,
        provider: 'cloudflare', verifiedAt: new Date().toISOString() }
    }
    if (remaining() > 0) await wait(Math.min(intervalMs, remaining()))
  }
  throw Error('webDeploy:matchingWebDeploymentTimedOut')
}
