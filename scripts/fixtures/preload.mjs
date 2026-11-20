import { fileURLToPath } from 'node:url'
import { assertFixtureRuntime, fixtureManifest, fixtureOrigin } from './guard.mjs'

const env = process.env
assertFixtureRuntime({ env, built: await fixtureManifest(fileURLToPath(new URL('../../', import.meta.url))), origin: env.MIKKA_FIXTURE_ORIGIN })
const services = fixtureOrigin(env.MIKKA_FIXTURE_SERVICES), github = fixtureOrigin(env.MIKKA_FIXTURE_GITHUB)
fixtureOrigin(env.MIKKA_LITELLM_URL)
const send = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init), url = new URL(request.url)
  const target = url.origin === 'https://api.github.com' ? `${github}/github${url.pathname}${url.search}`
    : url.origin === 'https://slack.com' && url.pathname.startsWith('/api/') ? `${services}/slack${url.pathname}${url.search}`
    : url.origin === 'https://api.e2b.app' ? `${services}/e2b/api${url.pathname}${url.search}` : null
  if (target) return send(new Request(target, request), { redirect: 'error' })
  fixtureOrigin(url.origin)
  return send(request, { redirect: 'error' })
}
