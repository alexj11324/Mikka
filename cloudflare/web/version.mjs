// A service binding belongs to one immutable API release. Store only public
// values read from that backend. Never retain a Response or request-scoped I/O.
const versions = new WeakMap()
const fields = ['build', 'overlaySha', 'minMobileBuild', 'mobileUpdateUrl', 'minDesktopVersion']
const headers = { 'cache-control': 'no-store, max-age=0', 'content-type': 'application/json' }

export async function publicVersion(request, env) {
  const head = request.method === 'HEAD'
  const failure = (error, status = 503) => new Response(head ? null : JSON.stringify({ error }), {
    status, headers: { ...headers, 'cache-control': 'no-store' },
  })
  const saved = versions.get(env.API)
  if (saved && saved.build === env.RELEASE_SHA && saved.overlaySha === env.OVERLAY_SHA) {
    return new Response(head ? null : saved.json, { headers })
  }
  // This pre-login route never needs client authority. Read the exact private
  // backend even for HEAD, so no client cookies or request headers enter state.
  const url = new URL('/mikka/api/version', request.url)
  let value
  try {
    const upstream = await env.API.fetch(new Request(url, { redirect: 'manual', signal: request.signal }))
    if (upstream.status !== 200 || !upstream.headers.get('content-type')?.includes('application/json')) {
      return failure('deploymentVersionUnavailable', upstream.status >= 400 ? upstream.status : 503)
    }
    value = await upstream.json()
  } catch (cause) {
    if (request.signal.aborted) throw cause
    return failure('deploymentVersionUnavailable')
  }
  if (!value || value.build !== env.RELEASE_SHA || value.overlaySha !== env.OVERLAY_SHA) {
    return failure('deploymentVersionMismatch')
  }
  if (Object.keys(value).length !== fields.length || !fields.every(key => Object.hasOwn(value, key))
    || !Number.isSafeInteger(value.minMobileBuild) || value.minMobileBuild < 0 || typeof value.mobileUpdateUrl !== 'string'
    || !(value.minDesktopVersion === null || typeof value.minDesktopVersion === 'string')) {
    return failure('deploymentVersionInvalid')
  }
  const json = JSON.stringify(value)
  versions.set(env.API, { build: value.build, overlaySha: value.overlaySha, json })
  return new Response(head ? null : json, { headers })
}
