// The reviewed service binding owns the API identity. Its code can update in
// place independently of these Web assets, so read its public version afresh.
import { versionPath } from './route-path.mjs'
import { HOSTED_API_HEADERS } from '../../packages/protocol/src/version.ts'

const fields = ['build', 'overlaySha', 'minMobileBuild', 'mobileUpdateUrl', 'minDesktopVersion']
const compatibilityFields = ['apiVersion', 'minApiVersion']
const sha = /^[a-f0-9]{40}$/
const headers = { 'cache-control': 'no-store, max-age=0', 'content-type': 'application/json' }

export async function publicVersion(request, env, ctx) {
  const head = request.method === 'HEAD'
  const failure = (error, status = 503) => new Response(head ? null : JSON.stringify({ error }), {
    status, headers: { ...headers, 'cache-control': 'no-store' },
  })
  // This pre-login route never needs client authority. Read the exact private
  // backend even for HEAD, so no client cookies or request headers enter state.
  const url = new URL(versionPath, request.url)
  let value
  try {
    // Bound cold discovery to the existing web client's version-read budget.
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)])
    const upstream = await env.API.fetch(new Request(url, { redirect: 'manual', signal, headers: HOSTED_API_HEADERS }))
    if (upstream.status !== 200 || !upstream.headers.get('content-type')?.includes('application/json')) {
      if (upstream.body) {
        const cleanup = upstream.body.cancel().catch(() => {})
        ctx?.waitUntil(cleanup)
      }
      return failure('deploymentVersionUnavailable', upstream.status >= 400 ? upstream.status : 503)
    }
    value = await upstream.json()
  } catch (cause) {
    if (request.signal.aborted) throw cause
    return failure('deploymentVersionUnavailable')
  }
  if (!value || ![value.build, value.overlaySha, env.RELEASE_SHA, env.OVERLAY_SHA].every(value => typeof value === 'string' && sha.test(value))) {
    return failure('deploymentVersionInvalid')
  }
  const hasCompatibility = compatibilityFields.some(key => Object.hasOwn(value, key))
  const allowedFields = hasCompatibility ? [...fields, ...compatibilityFields] : fields
  if (Object.keys(value).length !== allowedFields.length || !allowedFields.every(key => Object.hasOwn(value, key))
    || !Number.isSafeInteger(value.minMobileBuild) || value.minMobileBuild < 0 || typeof value.mobileUpdateUrl !== 'string'
    || !(value.minDesktopVersion === null || typeof value.minDesktopVersion === 'string')
    || hasCompatibility && (!Number.isSafeInteger(value.apiVersion) || !Number.isSafeInteger(value.minApiVersion)
      || value.minApiVersion < 0 || value.apiVersion < value.minApiVersion)) {
    return failure('deploymentVersionInvalid')
  }
  // Existing tabs compare `build` with their compiled Web source. Keep that
  // contract and report the binding's current API source separately. The private
  // publisher checks these actual pins against the authenticated manifest.
  const published = { ...value, build: env.RELEASE_SHA, overlaySha: env.OVERLAY_SHA, apiBuild: value.build, apiOverlaySha: value.overlaySha }
  const json = JSON.stringify(published)
  return new Response(head ? null : json, { headers })
}
