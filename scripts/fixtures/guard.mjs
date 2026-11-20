import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])
export const fixtureTarget = 'local-fixture'

export function assertFixtureBuild(env = process.env) {
  if (env.VERCEL || env.VERCEL_ENV || env.NITRO_PRESET && env.NITRO_PRESET !== 'node-server'
    || env.MIKKA_DEPLOYMENT_STAGE === 'production') throw new Error('FIXTURE_DEPLOYMENT_FORBIDDEN')
}

export function fixtureDatabase(env = process.env) {
  const values = ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL', 'ORVILO_DATABASE_URL'].map(key => env[key]).filter(Boolean)
  if (!values.length) throw new Error('FIXTURE_DATABASE_REQUIRED')
  const urls = values.map(value => {
    let url
    try { url = new URL(value) } catch { throw new Error('FIXTURE_DATABASE_INVALID') }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !loopback.has(url.hostname)
      || !/^\/[a-zA-Z0-9_]+_e2e$/.test(url.pathname) || url.search || url.hash) throw new Error('FIXTURE_DATABASE_NOT_DISPOSABLE')
    return url
  })
  if (urls.some(url => url.hostname !== urls[0].hostname || url.port !== urls[0].port || url.pathname !== urls[0].pathname))
    throw new Error('FIXTURE_DATABASES_MUST_MATCH')
  return urls[0]
}

export function fixtureOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !loopback.has(url.hostname) || url.username || url.password || url.search || url.hash
    || url.pathname !== '/') throw new Error('FIXTURE_ORIGIN_NOT_LOOPBACK')
  return url.origin
}

export function assertFixtureRuntime({ env = process.env, built, origin }) {
  assertFixtureBuild(env)
  if (built?.target !== fixtureTarget || built.preset !== 'node-server') throw new Error('FIXTURE_RELEASE_BUILD_FORBIDDEN')
  const database = fixtureDatabase(env)
  return { database, origin: fixtureOrigin(origin) }
}

export async function fixtureManifest(root) {
  return JSON.parse(await readFile(resolve(root, '.output/mikka-build.json'), 'utf8'))
}
