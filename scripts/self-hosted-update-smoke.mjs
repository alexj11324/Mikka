import assert from 'node:assert/strict'
import { request } from 'node:http'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export function healthTarget(env = process.env) {
  const origin = new URL(env.BETTER_AUTH_URL || 'http://localhost:3000')
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash ||
    origin.username || origin.password) throw new Error('SELF_HOSTED_UPDATE_SMOKE_ORIGIN_INVALID')
  const port = Number(env.PORT || 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SELF_HOSTED_UPDATE_SMOKE_PORT_INVALID')
  return { host: origin.host, port }
}

/** Request the local app without traversing public DNS/TLS or a proxy.
 * Preserve the configured Host so runtime origin guards behave exactly as
 * they do on the normal reverse-proxied service. */
export async function localResponse(path, env = process.env) {
  const target = healthTarget(env)
  return new Promise((accept, reject) => {
    const call = request({
      hostname: '127.0.0.1',
      port: target.port,
      path,
      method: 'GET',
      headers: { host: target.host },
      timeout: 5_000
    }, response => {
      const chunks = []
      let length = 0
      response.on('data', chunk => {
        length += chunk.length
        if (length > 64 * 1024) call.destroy(new Error('SELF_HOSTED_UPDATE_SMOKE_RESPONSE_TOO_LARGE'))
        else chunks.push(chunk)
      })
      response.once('end', () => accept({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    call.once('timeout', () => call.destroy(new Error('SELF_HOSTED_UPDATE_SMOKE_TIMEOUT')))
    call.once('error', reject)
    call.end()
  })
}

export async function upgradedSmoke(env = process.env, get = path => localResponse(path, env)) {
  if (!/^[0-9a-f]{40}$/.test(env.MIKKA_EXPECTED_REVISION || '')) throw new Error('SELF_HOSTED_UPDATE_SMOKE_EXPECTED_REVISION_REQUIRED')
  const version = await get('/mikka/api/version')
  assert.equal(version.status, 200, 'SELF_HOSTED_UPDATE_SMOKE_VERSION_UNAVAILABLE')
  const v = JSON.parse(version.body)
  assert.equal(v.build, env.MIKKA_EXPECTED_REVISION, 'SELF_HOSTED_UPDATE_SMOKE_REVISION_MISMATCH')
  const desktop = await get('/mikka/api/desktop/discovery')
  assert.equal(desktop.status, 200, 'SELF_HOSTED_UPDATE_SMOKE_DESKTOP_UNAVAILABLE')
  const d = JSON.parse(desktop.body)
  assert.equal(d.version, env.MIKKA_EXPECTED_REVISION, 'SELF_HOSTED_UPDATE_SMOKE_DESKTOP_REVISION_MISMATCH')
  assert.equal(d.edition, 'community', 'SELF_HOSTED_UPDATE_SMOKE_COMMUNITY_REQUIRED')
  const server = await get('/mikka/api/server')
  assert.equal(server.status, 200, 'SELF_HOSTED_UPDATE_SMOKE_SERVER_UNAVAILABLE')
  const details = JSON.parse(server.body)
  assert.equal(details.version, env.MIKKA_EXPECTED_REVISION, 'SELF_HOSTED_UPDATE_SMOKE_SERVER_REVISION_MISMATCH')
  assert.equal(details.status?.database, 'ready', 'SELF_HOSTED_UPDATE_SMOKE_DATABASE_UNAVAILABLE')
  const signIn = await get('/mikka/sign-in')
  assert.equal(signIn.status, 200, 'SELF_HOSTED_UPDATE_SMOKE_SIGNIN_UNAVAILABLE')
  assert.match(signIn.body, /<html\b/i, 'SELF_HOSTED_UPDATE_SMOKE_SIGNIN_INVALID')
  return { status: 'passed', revision: v.build, database: 'ready', desktop: true, signIn: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await upgradedSmoke())) }
  catch (error) {
    const code = /^SELF_HOSTED_UPDATE_SMOKE_[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'SELF_HOSTED_UPDATE_SMOKE_FAILED'
    console.error(code)
    process.exitCode = 1
  }
}
