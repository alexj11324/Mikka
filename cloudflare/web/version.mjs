// A service binding belongs to one immutable API release, which can differ
// from the Web assets' source. Validate both pins and retain only public
// values; never retain a Response or request-scoped I/O.
import { versionPath } from './route-path.mjs'

const versions = new WeakMap()
const fields = ['build', 'overlaySha', 'minMobileBuild', 'mobileUpdateUrl', 'minDesktopVersion']
const compatibilityFields = ['apiVersion', 'minApiVersion']
const headers = { 'cache-control': 'no-store, max-age=0', 'content-type': 'application/json' }

export async function publicVersion(request, env, ctx) {
  const head = request.method === 'HEAD'
  const failure = (error, status = 503) => new Response(head ? null : JSON.stringify({ error }), {
    status, headers: { ...headers, 'cache-control': 'no-store' },
  })
  const saved = versions.get(env.API)
  // Older release inputs used the same immutable pair for Web and API.
  const apiBuild = env.API_RELEASE_SHA ?? env.RELEASE_SHA
  const apiOverlaySha = env.API_OVERLAY_SHA ?? env.OVERLAY_SHA
  if (saved && saved.build === env.RELEASE_SHA && saved.overlaySha === env.OVERLAY_SHA
    && saved.apiBuild === apiBuild && saved.apiOverlaySha === apiOverlaySha) {
    return new Response(head ? null : saved.json, { headers })
  }
  // This pre-login route never needs client authority. Read the exact private
  // backend even for HEAD, so no client cookies or request headers enter state.
  const url = new URL(versionPath, request.url)
  let value
  try {
    // Bound cold discovery to the existing web client's version-read budget.
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)])
    const upstream = await env.API.fetch(new Request(url, { redirect: 'manual', signal }))
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
  if (!value || value.build !== apiBuild || value.overlaySha !== apiOverlaySha) {
    return failure('deploymentVersionMismatch')
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
  // contract while exposing the verified backend's distinct source explicitly.
  const published = { ...value, build: env.RELEASE_SHA, overlaySha: env.OVERLAY_SHA, apiBuild: value.build, apiOverlaySha: value.overlaySha }
  const json = JSON.stringify(published)
  versions.set(env.API, { build: published.build, overlaySha: published.overlaySha, apiBuild, apiOverlaySha, json })
  return new Response(head ? null : json, { headers })
}
