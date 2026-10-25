// GET-only deployment probes. Status reads can trigger lifecycle cleanup.
// Explicit cleanup authorization is required; never print HTTP bodies.
import { pathToFileURL } from 'node:url'
import { basePath } from '../lib/base-path-config.mjs'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export async function checkDeployment(config, fetcher = fetch) {
  if (config.lifecycleApproved !== true) throw new Error('lifecycle_approval_required')
  const origin = new URL(config.origin)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid_target')
  if (!/^[a-f0-9]{40}$/.test(config.sha ?? '')) throw new Error('invalid_sha')
  if (config.requestId && !uuid.test(config.requestId)) throw new Error('invalid_request_id')
  const checks = []
  const probe = async (name, path, cookie, expected) => {
    try {
      const response = await fetcher(new URL(`${basePath}${path}`, origin), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: cookie ? { Cookie: cookie } : {},
      })
      // Discard all response bytes: state bodies can contain references or nonces.
      await response.body?.cancel()
      const noStore = /(?:^|,)\s*(?:private\s*,\s*)?no-store(?:\s*,|$)/i.test(response.headers.get('cache-control') ?? '')
      checks.push({ name, status: response.status, noStore, passed: response.status === expected && noStore })
    } catch { checks.push({ name, passed: false, error: 'request_failed' }) }
  }
  await probe('unauthenticated_denied', '/api/credential-requests/00000000-0000-4000-8000-000000000000', undefined, 401)
  if (config.requestId && config.ownerCookie) {
    await probe('owner_status_read', `/api/credential-requests/${config.requestId}`, config.ownerCookie, 200)
    if (config.otherOwnerCookie) await probe('other_owner_denied', `/api/credential-requests/${config.requestId}`, config.otherOwnerCookie, 404)
  }
  return {
    checkedAt: new Date().toISOString(), targetOrigin: origin.origin, basePath, declaredSourceSha: config.sha,
    // The operator must independently prove deployment -> SHA; HTTP probes cannot attest it.
    deploymentShaVerified: false, checks,
    result: checks.every(check => check.passed) && checks.length === 3 ? 'GET_PROBES_PASS' : 'INCOMPLETE_OR_FAILED',
    productionAcceptanceComplete: false,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await checkDeployment({
      lifecycleApproved: process.env.MIKKA_ACCEPTANCE_LIFECYCLE_APPROVED === '1',
      origin: process.env.MIKKA_ACCEPTANCE_ORIGIN, sha: process.env.MIKKA_ACCEPTANCE_SHA,
      requestId: process.env.MIKKA_ACCEPTANCE_REQUEST_ID,
      ownerCookie: process.env.MIKKA_ACCEPTANCE_OWNER_COOKIE,
      otherOwnerCookie: process.env.MIKKA_ACCEPTANCE_OTHER_OWNER_COOKIE,
    })
    console.log(JSON.stringify(report, null, 2))
    if (report.result !== 'GET_PROBES_PASS') process.exitCode = 1
  } catch { console.error('Deployment probe configuration invalid; no acceptance claimed.'); process.exitCode = 1 }
}
